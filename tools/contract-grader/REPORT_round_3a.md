# Round 3a — Variance Check on Round 2 PDF Extraction Fix

Generated 2026-05-02T15:37:42.921Z

## Question being tested

Round 2 produced clean directional improvements on every reasoning quality metric (MECHANICAL/GENERIC/CONTEXTUAL/EXEMPLARY all moved correctly), but EXEMPLARY came in at 1 — below the spec's ≥3 pass threshold. This round runs the same scenario four times (2 DOCX + 2 PDF post-fix) to determine whether the EXEMPLARY shortfall is sample variance against an outlier baseline (Round 1's DOCX run-02 had EXEMPLARY=5, the highest of 12 DOCX runs; median 0, mean 1.6) or a real residual format-induced reasoning loss.

Scenario fixed for all four runs:

- Profile: `profile_buyer_positions`
- Posture: `their_paper_high_leverage`
- Pipeline mode: `standard` (7 specialists with SaaS auto-enabled)
- Code state: Round 2 codebase (PDF extraction fix in `extract.js`)

## Run results

| Run | Format | Total | MECH | GEN | CTX | EX | Tokens | Wall (s) |
|---|---|---|---|---|---|---|---|---|
| `r3a-docx-a` | docx | 26 | 0 | 15 | 11 | 0 | 114868 | 612.3 |
| `r3a-docx-b` | docx | 27 | 1 | 11 | 15 | 0 | 129555 | 585.4 |
| `r3a-pdf-a` | pdf | 22 | 1 | 8 | 12 | 1 | 118146 | 559.1 |
| `r3a-pdf-b` | pdf | 23 | 1 | 9 | 13 | 0 | 117623 | 545.2 |

Reference data from prior rounds:

| Run | Format | Total | MECH | GEN | CTX | EX |
|---|---|---|---|---|---|---|
| DOCX run-02 R1 | docx | 24 | 2 | 5 | 12 | 5 |
| PDF run-02 pre-fix R1 | pdf | 34 | 2 | 13 | 19 | 0 |
| PDF run-02 post-fix R2 | pdf | 18 | 1 | 5 | 11 | 1 |

## Variance analysis

### DOCX EXEMPLARY across 3 runs (R3a runs A+B + R1 run-02)

- Values: 0, 0, 5
- Range: 0–5 (spread 5)
- Mean: 1.67
- Standard deviation: 2.36

### PDF post-fix EXEMPLARY across 3 runs (R3a runs A+B + R2 run-02-pdf)

- Values: 1, 0, 1
- Range: 0–1 (spread 1)
- Mean: 0.67
- Standard deviation: 0.47

## Determination

Per spec gates:

- **DOCX EXEMPLARY any value ≤ 2** (would indicate variance): ✅ YES
- **PDF post-fix EXEMPLARY ≥ 1 in all runs** (would indicate stability): ❌ NO
- **DOCX mean ≤ 2.5 AND |DOCX mean − PDF mean| ≤ 1** (parity): ✅ YES (DOCX mean 1.67, PDF mean 0.67, gap 1.00)

**SHIP Round 2 as-is.**

The Round 2 PDF extraction fix improves reasoning quality, and the EXEMPLARY=1 result on the original Round 2 run is consistent with within-format sample variance — DOCX itself produces EXEMPLARY counts in the same range across reruns of the identical scenario. The structural fix is a strict improvement and is safe to deploy.

## Findings comparison (verbatim rationales)

To support human judgment, here are the EXEMPLARY-classified findings from each run.

### r3a-docx-a — docx — 0 EXEMPLARY finding(s)

_(no EXEMPLARY findings)_
---

### r3a-docx-b — docx — 0 EXEMPLARY finding(s)

_(no EXEMPLARY findings)_
---

### r3a-pdf-a — pdf — 1 EXEMPLARY finding(s)

**`coherence-checker-001`** · blocker · category `coherence`

> The interaction between Net-60 payment terms and the newly negotiated 60-day cure period for breach creates a concrete trap: Customer's cure period for payment breach is functionally zero days, because the breach occurs at day 61 and the 60-day cure period runs backward into the original Net-60 window. This contradicts the intent of the symmetric-cure edit and creates asymmetric enforcement risk. If Customer faces cash-flow delay and pays on day 65, Lattice can issue breach notice on day 66, and Customer's only 'cure' is time travel. The coherence issue is that the accepted cure-period edit assumes a meaningful cure window exists, but payment terms negate that assumption for the most common breach scenario (late payment).

---

### r3a-pdf-b — pdf — 0 EXEMPLARY finding(s)

_(no EXEMPLARY findings)_
---

## Cost

Total tokens used (4 runs): 480,192
Approximate cost: $8.64 (rough Sonnet 4.5 estimate at 50/50 in/out split)
