# Contract-Grader Methodology

Standards for designing, running, and interpreting contract-review tuning rounds.

This document codifies what we've learned through Rounds 1, 2, and 3a. Update it whenever a round produces a methodological finding worth carrying forward.

## 1. Variance is real and large for some metrics

The reasoning-quality metrics this grader produces have very different stability characteristics across reruns of the *identical* scenario. Round 3a measured this directly by running profile_buyer_positions × their_paper_high_leverage four times (2 DOCX + 2 PDF post-fix) plus the existing R1/R2 baseline (3 DOCX values total + 3 PDF values total).

| Metric | DOCX values across 3 runs | Range | SD | Stability |
|---|---|---|---|---|
| Total findings | 24, 26, 27 | 3 | ~1.2 | **Stable** (±15%) |
| MECHANICAL | 0, 1, 2 | 2 | ~0.8 | **Stable** (low absolute counts) |
| GENERIC | 5, 11, 15 | 10 | ~4.0 | Moderate variance |
| CONTEXTUAL | 11, 12, 15 | 4 | ~1.7 | **Stable** (especially as a share of total) |
| EXEMPLARY | 0, 0, 5 | 5 | ~2.4 | **High variance** |

The same pattern held on PDF post-fix (3 runs): EXEMPLARY swung between 0 and 1, CONTEXTUAL stayed in 11–13, total in 18–23.

**Takeaway:** EXEMPLARY count is too noisy to use as a single-run pass/fail gate. It's a directional indicator, not a measurement.

## 2. Recommended minimum-run counts

Use the table below to size future rounds. The "primary metric" column says what's driving the round's pass/fail decision; the run count guards against single-sample noise on that metric.

| Round purpose | Primary metric | Runs per condition | Why |
|---|---|---|---|
| Smoke-test a new specialist or prompt change | Total findings, MECHANICAL | 1 | These metrics are stable enough that a single run reads correctly |
| Verify a structural fix (e.g., extraction, parsing) | Total findings, CONTEXTUAL share, MECHANICAL | 2 | Accounts for moderate per-run variance without quadrupling cost |
| Grade reasoning quality changes | EXEMPLARY count, CONTEXTUAL share | **3** | EXEMPLARY's SD ~2.4 means a single run is unreliable; 3 runs lets the median tell a meaningful story |
| Side-by-side format/profile/posture comparison | All quality metrics | 2 per side | Eight runs total for a 4-cell matrix; expensive but produces a publishable table |
| Regression-suite-style sweep across many scenarios | Total findings, MECHANICAL aggregate | 1 per scenario, ≥6 scenarios | Many-scenarios-once beats few-scenarios-many-times when looking for systemic patterns |

**Pass/fail conditions should use multi-run means or medians, never single-run absolute counts on EXEMPLARY.**

## 3. Stable metrics — use these for gates

Listed in increasing order of variance. Prefer the top of this list for hard gates.

1. **Total finding count** — within ±15% across reruns. Best baseline-stability metric. Useful for "did the change break the pipeline."
2. **MECHANICAL count** — low absolute values, stable. This is the *failure-mode metric* — high MECHANICAL means the tool is rote-enforcing the playbook instead of reasoning. Going from 5→2 is a real improvement; going from 2→1 is noise.
3. **CONTEXTUAL count and CONTEXTUAL share** — stable in absolute, even more stable as % of total. CONTEXTUAL share rising at constant total finding count is a clean signal that reasoning quality improved.
4. **GENERIC count** — moderately stable. Useful directionally but not as a hard gate.
5. **EXEMPLARY count** — high variance. Use only for directional indication. **Do not gate on absolute counts.**

If you must use EXEMPLARY in a gate, use the multi-run mean and require it to differ from baseline by at least 1.5× the observed SD on that metric (about 3.5 EXEMPLARY for our test contract).

## 4. Cost estimates

Costs are dominated by the LLM calls inside each pipeline run. Estimates below are with prompt caching enabled and Sonnet 4.5 pricing as of Round 3a.

| Activity | Cost per unit |
|---|---|
| Single pipeline run (6,000-word contract, standard mode, 7 specialists + auditor + compiler + posture-LLM + coherence) | **~$0.60–$0.85** |
| Cached-input pipeline run (same profile + contract + posture as a recent run) | **~$0.30–$0.45** (50% savings from cache hits on system prompt + profile + contract) |
| Rationale grading (per finding, single short LLM call) | ~$0.001 — negligible |
| Full grading of a 25-finding run | ~$0.025 |
| Playbook → profile conversion (LLM-driven schema-fitter) | ~$0.05 once per playbook |

**Round-budget rules of thumb:**

| Round shape | Budget |
|---|---|
| 4-run variance check (1 scenario × 4 runs) | $2–3 |
| 12-scenario matrix, parallel | $7–10 |
| 12-scenario matrix, sequential | $7–10 (same; sequential just slows wall time, not cost) |
| 5-scenario × 2-run regression | $6–8 |

Rate-limit caveat: at the org tier observed in Rounds 1–3a (90,000 output tokens/min), more than ~3 parallel runs cause specialist failures from 429s. Rounds with >3 concurrent pipelines should either rely on prompt caching (each subsequent run benefits) or run fully sequential (slower wall time, but no failures).

## 5. Test-fixture conventions

The repo's standing test fixtures (don't change without coordinating with all open rounds):

- `tools/contract-grader/test_contracts/msa_reasoning_test.docx` — 4,436-word vendor's-paper SaaS MSA. Provisions chosen to exercise reasoning vs. mechanical playbook enforcement.
- `tools/contract-grader/test_contracts/msa_reasoning_test.pdf` — born-digital export of the same content via pdf-lib.
- `tools/contract-grader/test_profiles/profile_buyer_positions.json` — buyer-side profile with full playbook positions.
- `tools/contract-grader/test_profiles/profile_empty.json` — DEFAULT_PROFILE-equivalent with no positions.
- `tools/contract-grader/test_profiles/playbook_buyer_positions.docx` — same positions as `profile_buyer_positions.json` rendered as prose for testing the playbook-upload path.

## 6. Harness conventions

- `tools/contract-grader/harness.mjs` runs the full pipeline locally, bypassing Supabase. It mirrors `netlify/functions/fanout-background.js`'s `processReview` flow and writes a complete findings JSON to `tools/contract-grader/runs/<label>.json`.
- `tools/contract-grader/grade_rationales.mjs` runs the LLM judge over a single completed run and writes `<label>.graded.json` alongside.
- Per-round outputs should live under `tools/contract-grader/round-N-runs/` to keep the runs/ directory clean across rounds.

## 7. Round-numbering convention

- Round N for a discrete unit of testing or fixing.
- Round Na, Nb, Nc when a single round needs multiple sub-rounds (e.g., variance check or A/B test against the same fix).
- Each round produces a `REPORT_round_N.md` (or `REPORT_round_Na.md`) at the top of `tools/contract-grader/`.

## 8. Methodology revision history

| Round | Methodology change |
|---|---|
| Round 1 | Initial framework: 12-scenario matrix; rationale-quality LLM judge; 4-bucket classification (MECHANICAL/GENERIC/CONTEXTUAL/EXEMPLARY) |
| Round 2 | Single-scenario verification was deemed sufficient for structural fixes; introduced free-pre-test paragraph-count check before paying for pipeline runs |
| Round 3a | Variance methodology established (this doc). EXEMPLARY recognized as high-variance; multi-run protocols required for reasoning-quality decisions |
