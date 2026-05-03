# Tuning Roadmap — Contract-Review Agents

How to make the agents reason more like a senior lawyer over time, with a measurement loop, not pure intuition. Companion to METHODOLOGY.md (which establishes variance baselines and run-count protocols).

## The mental model: "tuning" is prompt iteration with measurement

There is no fine-tuning of model weights here. The "training" loop is:

```
  baseline run  →  grade rationales  →  diagnose failure mode
       ↑                                       ↓
  ship if better                         targeted prompt edit
       ↑                                       ↓
  multi-run verify  ←  rerun on same scenario
```

Every prompt edit is a hypothesis. Every grading session tests it. Every multi-run verifies it survives variance.

## The four reasoning-quality buckets (from Round 1)

The rationale-grader categorizes each finding's reasoning into one of:

| Bucket | What it looks like | Want |
|---|---|---|
| **MECHANICAL** | "The Profile says X. The contract says Y. Therefore flag." | **Low** — the specialist wasn't reasoning, just matching |
| **GENERIC** | "This clause is risky and could harm Customer." | **Low** — no concrete harm named |
| **CONTEXTUAL** | Names specific harm in this deal, references other clauses, considers posture | **High share of total** — the senior-lawyer floor |
| **EXEMPLARY** | Identifies cross-section interactions, anticipates counterparty pushback, suggests fallback positions tied to deal economics | **Some, but high-variance metric** — directional only |

**Primary gate when iterating: CONTEXTUAL share of total findings. It's the most stable reasoning-quality signal and most directly connected to "lawyerly thinking."**

EXEMPLARY count is high-variance (SD ~2.4 across reruns of identical scenario per Round 3a) — useful directionally, NOT for ship/fail gates.

## The standing test setup

Located in `tools/contract-grader/`:

- **Test contract**: `test_contracts/msa_reasoning_test.docx` (and `.pdf`) — 4,436-word vendor's-paper SaaS MSA, designed to exercise reasoning vs mechanical matching
- **Test profiles**:
  - `profile_buyer_positions.json` — buyer-side, customer_side role, full playbook
  - `profile_empty.json` — DEFAULT_PROFILE-equivalent, no positions (forces baseline-judgment behavior)
- **Harness**: `harness.mjs` — runs the full pipeline locally, bypassing Supabase. Mirrors `processReview` flow verbatim.
- **Grader**: `grade_rationales.mjs` — LLM-judges each finding's rationale and writes a `<label>.graded.json`.

## The tuning loop, one round at a time

### Step 1 — Establish a clean baseline

```bash
# Two fixtures, three runs each (multi-run protocol from METHODOLOGY.md)
node tools/contract-grader/harness.mjs base-docx-1 \
  tools/contract-grader/test_contracts/msa_reasoning_test.docx \
  tools/contract-grader/test_profiles/profile_buyer_positions.json \
  their_paper_low_leverage

# Repeat with -2 and -3 labels for variance baseline
# Then DOCX × empty profile, PDF × buyer profile, etc. — see METHODOLOGY.md §6
```

Cost: ~$0.60–0.85 per uncached run; ~$0.30–0.45 cached. Three runs ≈ $2.

Then grade:

```bash
node tools/contract-grader/grade_rationales.mjs base-docx-1
# repeat for -2 and -3
```

This produces `runs/base-docx-1.graded.json` with each finding bucketed.

**Compute baseline metrics**:

| Metric | What to record | How to use |
|---|---|---|
| Total findings | Mean ± SD across 3 runs | "Did the change break the pipeline" gate |
| MECHANICAL count | Mean | Want LOW. Above 3 on a 22-finding run is a failure mode |
| CONTEXTUAL share | Mean (count / total findings) | Primary reasoning-quality signal |
| EXEMPLARY count | Mean | Directional only, do not gate |
| Anchor success rate | Total / (total + unanchored) | 95%+ baseline (Round 4 target) |

### Step 2 — Diagnose the failure mode

Read the actual graded findings. Not just counts, the *specific* findings the grader marked MECHANICAL or GENERIC. Look for patterns:

- Are MECHANICAL findings clustered in one specialist? (specialist-specific prompt issue)
- Are GENERIC findings all on a particular topic? (domain knowledge gap in the playbook or agent)
- Are CONTEXTUAL findings missing a specific reasoning move? (e.g., never references cross-section interactions)
- Are unanchored findings hitting `source_text` mismatches? (extractor or anchor-derivation issue, not reasoning)

The diagnosis is qualitative. The *measurement* is quantitative.

### Step 3 — Targeted prompt edit

Edit the relevant `.md` file in `netlify/agents/`. Examples of moves that work:

| Failure mode | Prompt move |
|---|---|
| Specialists emit findings on items the playbook doesn't address but a senior lawyer wouldn't either | Tighten the three-question gate. Add a concrete example of "this is a style preference, not material." |
| Specialists never reason across sections | Add a `## Cross-section hazards for this specialist` block with the interactions to look for |
| Specialists copy playbook language verbatim instead of adapting to contract voice | Strengthen `## Drafting style` with examples of the contract's voice → the right register for proposed text |
| Specialists never propose fallback positions | Make `fallback` field's "REQUIRED when severity is blocker or major" guidance more prominent. Add an example in the worked-examples section |
| Specialists emit edits that leave broken grammar | (Just done) The `## Redline scope` block we restored today |

Keep edits **small** — change one specialist's prompt at a time, ideally one section at a time. Otherwise you can't tell what helped.

After every prompt edit, run `node scripts/build-agents-bundle.mjs` to regenerate the deployed bundle.

### Step 4 — Verify with the multi-run protocol

Per METHODOLOGY.md §2, reasoning-quality changes need 3 runs to gate ship/fail decisions:

```bash
node tools/contract-grader/harness.mjs round-N-docx-1 …
node tools/contract-grader/harness.mjs round-N-docx-2 …
node tools/contract-grader/harness.mjs round-N-docx-3 …
```

Compare the *median* of each metric to the baseline median. Ship if:

- CONTEXTUAL share is stable or higher (within ±5%)
- MECHANICAL count is stable or lower
- Total findings within ±15% of baseline (didn't accidentally break anything)
- No new specialist failures (`specialistFailures[]` empty)

### Step 5 — Document and ship

Write `REPORT_round_N.md` in `tools/contract-grader/` with:

- The hypothesis being tested
- The prompt change (diff or quote)
- The 3-run metrics, before/after
- Decision and rationale (ship vs iterate)

Commit and merge.

## Knobs you have besides prompts

The reasoning quality has more inputs than just specialist prompts. Other levers:

1. **Profile detail.** A thin profile forces specialists into Tier-2 baseline reasoning, which can be more or less lawyerly depending on the topic. Investing in profile depth (more positions, more red flags, more deal-economic context) raises CONTEXTUAL share.
2. **Posture-integrity rules.** `netlify/lib/posture-integrity.js` has a deterministic table of role-inversion checks. Adding more rules (e.g., "renewal-window changes that favor counterparty get rejected") catches errors specialist prompts can't.
3. **Coherence-checker prompt.** It's the last reasoning step before markup. Its sensitivity to "untouched clause now contradicts edits" is tunable in `netlify/agents/coherence-checker.md`.
4. **Critical-issues-auditor.** Currently catches material omissions and existential escalations. Could be extended to catch additional cross-cutting reasoning moves.
5. **Compiler `priority_three` selection logic.** What counts as "Top 3" worth showing the user first is decided by the compiler agent. Tuning that prompt changes what users see prominently.
6. **The grader itself.** `grade_rationales.mjs` uses an LLM-as-judge with rubric-based bucketing. The rubric is in the grader source — tightening it reshapes the entire feedback loop.

Don't confuse "the agents reasoned wrong" with "the grader bucketed it wrong." Periodically spot-check the grader's calls against your own reading.

## Cost discipline

From METHODOLOGY.md §4:

- Single run: ~$0.60–0.85 uncached, ~$0.30–0.45 cached
- 3-run verification: ~$2
- 12-scenario × 2-run matrix: ~$15
- Rationale grading per finding: ~$0.001 — negligible

A round of meaningful tuning typically costs **$5–15** total: baseline (3 runs) + post-change verification (3 runs) + a few exploratory single-run iterations.

## Known parked items worth picking up

These are not prompt-quality issues but structural reasoning gaps surfaced in prior rounds:

| Issue | Why parked | Effort to address |
|---|---|---|
| Heading detection in PDF (Round 2) | Section headings flatten as paragraphs in PDF; specialists lose structural cues | Medium — need pdfjs font-size detection |
| Punctuation-spacing PDF↔DOCX divergence (Round 2) | Possible residual reasoning loss; never measured | Low — empirical 3-run A/B |
| Whole-clause vs targeted scope (Round 5d) | Was implemented and reverted; just restored to `## Redline scope` block in 8 specialists today | Verify with one 3-run cycle |
| Anchor success rate variability | 5–15% of findings unanchor; specialist hallucination + extraction quirks | Mostly Round-4 work (`stripQuotedSectionPrefix`, `tryInsertWithDerivedAnchor`); recoverable |
| Industry modules (construction, maritime, healthcare) | Defined in `agent_registry.json` but no `.md` files | High — need playbook research per industry |

## A first-90-days roadmap, if you want one

| Week | Goal | Approximate cost |
|---|---|---|
| 1 | Establish the baseline. 3-run on standard scenario. Read every graded finding. Write down 3 specific failure modes you see. | $2–3 |
| 2 | Address the highest-impact failure mode with a single prompt edit on one specialist. Multi-run verify. Document. | $4–5 |
| 3 | Address the second failure mode same way. | $4–5 |
| 4 | Address the third. | $4–5 |
| 5–6 | Restore Round-4 anchor reliability (port `stripQuotedSectionPrefix` + `tryInsertWithDerivedAnchor` from git history). Verify. | $4–5 |
| 7–8 | Multi-scenario sweep: 5 contract types × 2 postures = 10 scenarios, single run each. Look for systemic patterns the single-scenario tuning missed. | $6–8 |
| 9–12 | Pick the next biggest-leverage item from the methodology + parked list. Continue the loop. | $4–5 / round |

By month 3 you'll have run ~15 measured tuning rounds, seen the system's behavior on diverse contracts, and built intuition for which prompts move which metrics. That's the "training" part — humans iterating with feedback, not weights changing.

## Today's status (post-revert + restore)

- Production code is at `350e359` (Round 3a baseline + DOMMatrix fix + worker-file fix)
- This branch has the Round 5d scope-guidance restored on all 8 specialists (today's work)
- Round 4 anchor reliability: NOT in main (was on its own branch, deleted in revert) — recoverable from git reflog or by reimplementation
- Round 5a/5b PDF StrikeOut work: reverted; PDF markup currently uses drawn lines (broken). Path forward: PyMuPDF via Modal (in progress)
