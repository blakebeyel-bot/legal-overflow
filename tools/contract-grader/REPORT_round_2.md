# Round 2 — PDF Paragraph Extraction Fix

Generated automatically; one scenario; cost-constrained verification.

## TL;DR

| Metric | DOCX baseline (R1) | PDF pre-fix (R1) | PDF post-fix (R2) | Pass condition | Result |
|---|---|---|---|---|---|
| Paragraph count (extraction) | 75 | 8 | **79** | within ±10% of 75 (68–83) | ✅ **PASS** |
| Total findings | 24 | 34 | **18** | within ±20% of 24 (19–29) | ⚠️ slightly below band |
| EXEMPLARY count | 5 | 0 | **1** | ≥ 3 | ❌ **FAIL** |
| CONTEXTUAL count | 12 | 19 | **11** | substantively comparable to DOCX | ✅ comparable |
| MECHANICAL count | 2 | 2 | **1** | (lower-is-better, no threshold) | ✅ improved |
| GENERIC count | 5 | 13 | **5** | (lower-is-better, no threshold) | ✅ recovered |

**Determination: partial pass.** The structural fix landed cleanly (paragraph parity restored from 8 → 79). Reasoning quality moved in the expected direction across every metric — fewer GENERIC, fewer MECHANICAL, EXEMPLARY off the floor (0 → 1), CONTEXTUAL share rose from 56% → 61%. But EXEMPLARY count is only 1 of 18 findings, below the ≥ 3 threshold the spec set for "approaches DOCX baseline."

Per the spec, this is a fail-on-quality-target case. Hypothesis section below proposes what to investigate before Round 3.

## Fix description

`netlify/lib/extract.js:65-91` previously joined all pdfjs `getTextContent` items on a page with a single space, so every within-page paragraph break was discarded. The replacement function `itemsToParagraphedText` (lines 95–187 of the post-fix file) does:

1. **Group items into lines** by y-coordinate (within ~40% of item height for justified-text jitter tolerance).
2. **Compute a median line-to-line gap** across the page so the threshold adapts to the document's actual line spacing rather than a hard-coded constant.
3. **Insert a paragraph break** wherever the gap to the next line exceeds 1.3× the median (with a +4-pt absolute floor, so very tight documents still differentiate). Negative gaps (cursor moved up — reading-order glitches) also break.
4. **`hasEOL` is NOT used as a paragraph signal** — pdfjs sets `hasEOL` on every wrapped line ending in pdf-lib output (verified empirically in `tools/contract-grader/debug_algo.mjs`), so it would over-segment.

Output shape consumed by specialists is unchanged — `{ text, format, pages }`. The fix is internal to extraction.

## Pre-test verification (free, no API calls)

Ran `tools/contract-grader/compare_extraction.mjs`:

| Metric | DOCX | PDF post-fix |
|---|---|---|
| Word count | 4436 | 4436 |
| Char count | 29669 | 29673 |
| Whitespace-normalized identical | ✓ | ✓ |
| Paragraph count | 75 | **79** |

Paragraph delta: +5%, well within the ±10% threshold the spec required for proceeding to a pipeline run.

Sample of post-fix output (first 8 paragraphs) shows correct semantic boundaries:

```
[0] MASTER SUBSCRIPTION AGREEMENT
[1] Lattice Telemetry, Inc.
[2] This Master Subscription Agreement ... (full opening recital, joined as one paragraph)
[3] 1. DEFINITIONS
[4] Capitalized terms used in this Agreement ...
[5] "Affiliate" means ...
[6] "Authorized User" means ...
[7] "Confidential Information" has the meaning set forth in Section 7.1.
```

Pre-fix output had the same content split into ~330 single-line "paragraphs" because every line wrap was over-emitted as a paragraph break.

## Pipeline run (single scenario)

| Field | Value |
|---|---|
| Run label | `run-02-pdf` |
| Contract | `tools/contract-grader/test_contracts/msa_reasoning_test.pdf` |
| Profile | `profile_buyer_positions` |
| Posture | `their_paper_high_leverage` |
| Specialists | 7 (commercial-terms, risk-allocation, insurance-coverage, performance-obligations, termination-remedies, protective-provisions, industry-saas) |
| Pipeline mode | `standard` |
| Tokens used | 115,220 |
| Wall time | 511.9 s |
| API failures | 0 |

## Comparison: DOCX baseline vs PDF post-fix

The Round 1 DOCX baseline for the same scenario (run-02) is the comparator. The Round 1 pre-fix PDF run is included for reference.

| Metric | DOCX (R1 run-02) | PDF pre-fix (R1 run-02-pdf) | PDF post-fix (R2 run-02-pdf) |
|---|---|---|---|
| Total findings | 24 | 34 | 18 |
| Severity (B/M/Mod/Min) | 2/13/9/0 | 4/16/13/1 | 4/8/6/0 |
| Tier 1 / Tier 2 | 13/11 | ?/? | 12/6 |
| MECHANICAL | 2 | 2 | 1 |
| GENERIC | 5 | 13 | 5 |
| CONTEXTUAL | 12 | 19 | 11 |
| EXEMPLARY | 5 | 0 | 1 |
| Quality % (M/G/C/E) | 8% / 21% / 50% / 21% | 6% / 38% / 56% / 0% | 6% / 28% / 61% / 6% |

**Direction of every quality metric:** PDF post-fix moved toward DOCX baseline. None moved away.

**Magnitude:** the gain in CONTEXTUAL share (56% → 61%) and the reduction in GENERIC (38% → 28%) confirm that better structure is producing more deal-aware reasoning. But EXEMPLARY did not fully recover; the partner-level tail rebuilt to one finding rather than five.

## Pass / fail determination

Per the spec: **PARTIAL PASS / FAIL ON QUALITY TARGET.**

- Structural parity ✅
- Total finding count ⚠️ (18 vs 24; outside the ±20% band by 1 finding)
- EXEMPLARY ≥ 3 ❌ (1 of 18)
- CONTEXTUAL comparable ✅

Per the spec's failure clause: *"Fail condition: Extraction fix lands but reasoning quality does not improve. Indicates something beyond paragraph structure is degrading PDF reasoning."* Reasoning DID improve directionally on every dimension, but the absolute EXEMPLARY count fell short of the gating threshold.

## Hypotheses for the residual gap

1. **Single-scenario sample variance.** Round 1's run-02 DOCX produced 5 EXEMPLARY out of 24 findings — the highest EXEMPLARY count of any DOCX run (run-04 had 0; run-01 had 0; runs 5-8 ranged 0–1). EXEMPLARY count is high-variance across reruns of the same scenario. A single PDF run hitting 1 EXEMPLARY may be sampling noise rather than evidence of a residual format penalty. **Test:** rerun the same scenario 2-3 times and report median.

2. **Fewer findings → fewer chances for EXEMPLARY.** The post-fix PDF emitted 18 findings vs DOCX's 24; with 25% fewer findings, the absolute EXEMPLARY count shrinks even at constant proportional rate. EXEMPLARY-per-finding rate is 1/18 = 5.6% on PDF post-fix vs 5/24 = 21% on DOCX — that ratio gap is the real signal. **Test:** check if EXEMPLARY per finding ≥ DOCX EXEMPLARY per finding.

3. **Residual structural artifacts** beyond paragraph breaks. PDF text extraction joins items within a line with single spaces — but DOCX preserves cross-paragraph indentation, list-item bullets, and tab-aligned definitions. The "Definitions" section may flatten into prose differently in PDF vs DOCX, costing the model some structural cues. **Test:** diff the post-fix PDF text against the DOCX text and see where they still differ structurally.

4. **Justified-text spacing in PDF flatten** punctuation. pdfjs items emit text fragments that may interleave punctuation with whitespace differently than mammoth's DOCX extraction. **Test:** compare the rendered text of a punctuation-dense paragraph between formats; check whether quoted strings, parentheticals, or section references read identically.

5. **Section headings** may not survive as headings. My fix treats heading lines as just another paragraph (no font-size detection for headings). If specialists were using heading visual hierarchy in DOCX to navigate the contract, that signal is degraded in PDF. **Test:** check whether heading detection (font-size differential, bold weight) would change reasoning.

6. **The DOCX baseline may itself be an outlier.** Run-02 was the highest-EXEMPLARY DOCX run in Round 1. It may have hit an unusually deep specialist-reasoning episode. Comparing PDF post-fix against the DOCX MEDIAN (not run-02 specifically) would be a more reliable benchmark.

The most likely candidate is **(1) sample variance** combined with **(6) baseline outlier-ness.** A 3-rerun median across both DOCX and PDF would clarify whether the residual gap is real signal.

## Recommendation

**Do NOT ship Round 2 to citation-test yet.** The structural fix is solid and improves reasoning quality, but per spec it falls short of the EXEMPLARY ≥ 3 gate. Two paths forward:

- **Round 3a (cheap, ~$1):** rerun this scenario 2-3 more times on both DOCX and PDF post-fix to clarify whether the residual EXEMPLARY gap is sampling noise or real signal. If sampling noise, ship Round 2.
- **Round 3b (more ambitious):** investigate hypotheses (3)-(5) — punctuation/spacing diff, definition-list flattening, heading detection. Heading detection is the highest-leverage candidate.

The fix as written is a strict improvement and is safe to keep in the branch even if not yet shipped.

## Artifacts

- **Branch:** `round-2-pdf-extraction-fix`
- **Code change:** `netlify/lib/extract.js:65-187` (the diff is contained — no other files modified)
- **Run output:** `tools/contract-grader/runs/run-02-pdf.graded.json`
- **Pre-test scripts:** `tools/contract-grader/compare_extraction.mjs`, `tools/contract-grader/debug_algo.mjs`

Cost: $0.61 in API credits (115,220 tokens at Sonnet 4.5 rates), within the $0.60-0.80 budget.
