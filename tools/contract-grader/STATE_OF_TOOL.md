# Contract-Review Agent — State of the Tool

Baseline as of 2026-05-02 (post-revert of Rounds 5a/5b). Production restored to commit `350e359`, byte-identical to pre-tuning state at `36d5ffb`. Pipeline orchestrated by `netlify/functions/fanout-background.js`.

## 1. Architecture

| Step | Purpose | Inputs | Outputs | Code | Model |
|---|---|---|---|---|---|
| (a) Extract canonical text | Format-aware text extraction; rejects scanned PDFs (<200 chars) | Raw file `Buffer`, filename | `{ text, format, pages? }` | `netlify/lib/extract.js` → `extractDocumentText()`, `extractDocx()`, `extractPdf()`, `itemsToParagraphedText()` | none (deterministic; `mammoth` + `pdfjs-dist`) |
| (b) Classify document | Sync triage from `start-review.js`; sets `contract_type`, `pipeline_mode`, `confidence`, `is_subordinate`. Confidence guardrails: <0.85 forces `standard`; <0.4 also forces `standard` | First 20K chars | `{ contract_type, pipeline_mode, confidence, is_subordinate, reasoning }` written to `reviews` row | `netlify/functions/start-review.js` (lines 121-179); `netlify/agents/document-classifier.md` | `claude-sonnet-4-6` (FM); pinned ID in `lib/constants.js` |
| (c) Specialist fan-out | Up to 8 specialists run in parallel; each emits `{ coverage_pass, findings }`. Per-specialist failures captured (no silent drops); empty `coverage_pass` flagged as failure | Profile, contract text, posture envelope | All findings + coverage entries; `specialistFailures[]` | `fanout-background.js` → `processReview()` → `Promise.allSettled` over `resolveSpecialists()` (lines 113-214); `callSpecialist()` in `lib/anthropic.js` | Sonnet 4.6, 8192 max tokens each |
| (d) Critical-issues sweep | Catches material omissions, cross-section hazards, existential-escalations | All specialist findings + coverage_pass + ctx | New findings only (empty coverage_pass) | `fanout-background.js` lines 216-241; `agents/critical-issues-auditor.md` | Sonnet 4.6, 4096 max tokens |
| (e) Compile + posture + coherence + markup | LLM compiler validates schema, dedupes, prunes, orders, picks priority_three; deterministic posture-integrity rejects role-inverted edits (LLM escalation for ambiguous); coherence-checker catches contradictions and may restore rejected findings | Combined findings + ctx | `findings.json`, annotated DOCX/PDF, `Review_Summary.docx` | `fanout-background.js` lines 243-453; `lib/posture-integrity.js`; `lib/markup-docx.js`, `lib/markup-pdf.js`; `lib/review-summary.js`; agents `review-compiler.md`, `coherence-checker.md` | Compiler + coherence: Sonnet 4.6 (12K / 4K). Posture-integrity: deterministic table + ~150-token Sonnet 4.6 escalation |

`MODEL_ID` is single-source-of-truth in `lib/constants.js`. Cache control: profile + contract text + system prompt are marked `ephemeral` so each post-first specialist reads at ~90% discount.

## 2. Specialist Reviewers

All thirteen `.md` files live under `netlify/agents/`. All declare `model: claude-sonnet-4-6` in frontmatter.

| Agent | Domain | Profile incorporation | Invocation |
|---|---|---|---|
| `commercial-terms-analyst` | Payment, pricing, MFN, audit, set-off, late fees, retainage, taxes | Reads `PROFILE` for hard-requirement positions; falls back to industry-baseline when silent. Three-question gate before emit | All modes (standard + comprehensive) |
| `risk-allocation-analyst` | Indemnity, LoL caps, consequential damages, liquidated damages, warranty | Same gate; cross-section rules (cap vs carve-out) | All modes |
| `insurance-coverage-analyst` | CGL, E&O, cyber, AI, waiver of subrogation, A.M. Best | Cross-checks demanded coverages against `PROFILE.insurance` | All modes |
| `performance-obligations-analyst` | SLAs, acceptance, performance warranties, time-is-of-essence | Profile uptime/SLA targets; baseline checklist when silent | All modes |
| `termination-remedies-analyst` | Term, renewal, termination cause/convenience, cure, dispute resolution, governing law/venue, jury waiver, force majeure | Profile cure preferences, venue blacklist | All modes |
| `protective-provisions-analyst` | Confidentiality, IP/work-product, non-compete, non-solicit, exclusivity, assignment | Profile IP-ownership posture (esp. SaaS platform-IP retention) | All modes |
| `compliance-regulatory-analyst` | GDPR/CCPA, HIPAA/BAA, GLBA, PCI, SOC 2, export, sanctions, ABAC, subprocessors | Profile DPA/BAA willingness, audit rights | **Comprehensive only** |
| `industry-saas-analyst` | Uptime SLA construction, subprocessor architecture, API rate limits, usage-based pricing, source-code escrow, AUP. Supplemental — not replacing core specialists | Reads `enabled_modules.technology_saas` | Auto-attaches when `profile.enabled_modules.technology_saas === true` OR when `profile.company.industry` matches `/(saas|software-as-a-service\|cloud\|b2b software\|enterprise software\|hosted)/i` (regex in `resolveSpecialists()` of `fanout-background.js` lines 488-515). Industry modules only fold in when stage has `plus_enabled_industry_modules: true` (currently only `comprehensive`) |
| `industry-construction-analyst`, `industry-maritime-analyst`, `industry-healthcare-analyst` | Lien/site conditions; admiralty/Jones Act; HIPAA/Stark | Toggled in `enabled_modules` | **Not yet implemented as `.md`** — listed in `agent_registry.json.industry_modules` only. Docs say "scaffold via workflow-configurator if needed" |
| `coherence-checker` | Detects clauses untouched by edits that contradict accepted edits; reviews rejected findings for restore | Sees all accepted/rejected findings + coverage_pass aggregate | Always (final stage 5 before markup) |
| `critical-issues-auditor` | Material omissions, cross-section hazards, existential-escalation only — does NOT re-do specialists | Sees specialist findings + coverage; profile context | Always (between specialists and compiler) |

13 files total: 8 specialist analysts (7 wave-3 domain + 1 SaaS module), `document-classifier`, `review-compiler`, `critical-issues-auditor`, `coherence-checker`, `workflow-configurator`. Construction/maritime/healthcare modules appear in registry only.

## 3. Pipeline Modes

Definition lives in `netlify/config/agent_registry.json`. Mode chosen by classifier in `start-review.js`; `fanout-background.js` reads `review.pipeline_mode`.

| Mode | Specialists | Audit | Compile | Notes |
|---|---|---|---|---|
| **express** | None — only triage + assemble | none | review-compiler only | Designed for short NDAs / standard POs / order forms. **Currently degenerate**: would proceed with auditor + compiler on zero findings. Confidence guardrail in `start-review.js` forces `standard` whenever classifier confidence <0.85 — downgrades blocked |
| **standard** (default) | commercial-terms, risk-allocation, insurance-coverage, performance-obligations, termination-remedies, protective-provisions (6) | critical-issues-auditor | review-compiler | Most B2B contracts. SaaS module auto-attaches on industry-regex match even though `plus_enabled_industry_modules` is false in this stage — drift from registry intent |
| **comprehensive** | standard 6 + `compliance-regulatory-analyst` (7) + every enabled industry module (`plus_enabled_industry_modules: true`) | critical-issues-auditor | review-compiler | High-value, regulated, or complex contracts |

Token budgets (per call, set in `fanout-background.js`):
- Specialist: 8192
- Auditor: 4096
- Compiler: 12,000
- Coherence: 4096
- Posture-integrity escalation: ~150
- Per-review hard ceiling: `MAX_TOKENS_PER_REVIEW = 500_000` in `constants.js`; `callSpecialist` throws if exceeded

`workflow-configurator.md` is conversational only — interviews user to write `company_profile.json` / `agent_registry.json`. **Does not run mode selection at runtime**; mode-decision is deterministic in classifier + guardrails.

## 4. Deal-Posture Handling

Posture is collected upfront and saved to `reviews.deal_posture`. Allowed values (validated in `start-review.js` line 67): `our_paper | their_paper_high_leverage | their_paper_low_leverage | negotiated_draft`.

How specialists modify behavior (uniform across all 8 wave-3 prompts under `## Deal posture sensitivity`):

| Posture | Behavior |
|---|---|
| `our_paper` | High bar for accepting Profile deviation; broader scope for Tier-2 issues |
| `their_paper_high_leverage` | Existential + Blocker only; suppress moderate/minor unless concrete harm. "Client needs this deal" |
| `their_paper_low_leverage` | Standard posture; raise material issues freely |
| `negotiated_draft` | Assume earlier rounds resolved obvious items; focus on residual + newly introduced language |

Posture is included in every specialist envelope via `buildContextBlock()` (fanout-background.js lines 604-617) as `DEAL_POSTURE: <value>`. The auditor, compiler, and coherence-checker all receive the same context block.

`netlify/lib/posture-integrity.js` runs *after* the compiler and is **role-driven, not posture-driven**. Each specialist's `## Posture integrity note` codifies role-inversion rules. Deterministic rules table in `RULES[]` covers: net-term direction, liability-cap dollar/look-back direction, insurance-limit direction, SLA threshold direction. `cure-period-direction` and `confidentiality-duration-direction` rules return ambiguous and rely on LLM escalation. Ambiguous → ~150-token Sonnet 4.6 call with beneficiary-first system prompt + clause-type reference + 5 worked examples. Unknown role → ambiguous. Output: `{ accepted, rejected, metrics: { deterministic_pass, deterministic_fail, escalated, escalation_fail } }`. Coherence-checker re-runs `postureCheckFinding` on any restored finding (defense in depth).

## 5. Output Schema

Required fields on every finding (per master template in `commercial-terms-analyst.md`, replicated across wave-3 specialists; enforced by `validateFindingSchema()` in `fanout-background.js` lines 558-600):

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | format `<specialist>-NNN`; auto-assigned `f<n>` if missing |
| `specialist` | string | yes | tagged in `normalizeSpecialistOutput` |
| `tier` | 1 \| 2 | yes | 1 if `profile_refs` non-empty, 2 otherwise |
| `category` | string | yes | short string within specialist's domain |
| `severity` | `blocker \| major \| moderate \| minor` | yes | enum |
| `existential` | boolean | yes (coerced false if missing) | orthogonal to severity |
| `markup_type` | `replace \| insert \| delete \| annotate` | yes | drives markup module |
| `source_text` | string \| null | yes | exact contract text (null for insert) |
| `proposed_text` | string \| null | yes (`suggested_text` alias) | null for delete/annotate; aliased to `suggested_text` for markup compatibility (Wave-3 vs Wave-1/2) |
| `external_comment` | string | yes | 1-3 sentences, counterparty-facing voice |
| `materiality_rationale` | string ≥10 chars | **schema-enforced** | concrete-harm naming; rejection key for proportionality |
| `playbook_fit` | `applies \| applies_with_modification` | when tier 1 | `overkill_for_this_deal` is record-only, never emitted as finding |
| `profile_refs` | string[] | yes | empty array for tier 2 |
| `position` | string ≥3 chars | **schema-enforced** | client opening ask |
| `fallback` | string | when severity ∈ blocker/major OR existential true | schema-rejects if missing |
| `walkaway` | string | when existential true | schema-rejects if missing |
| `jurisdiction_assumed` | string | yes (placeholder coerced if missing) | |
| `coherence_with` | string[] (id refs) | coherence findings only | UI uses to visually link |

Findings JSON envelope (`schema_version: 2`, written to `findings.json`):
```
{ findings, priority_three (≤3 ids), coverage_pass_aggregate, rejected_findings,
  specialist_failures, expected_specialists, metrics }
```

Coverage entry shape: `{ specialist, item, source: "profile"|"baseline", profile_ref, status: present|absent|cross_referenced_to_master|partially_addressed|not_applicable_to_this_deal, evidence, playbook_fit }`. Coverage pass is exhaustive and required — empty `coverage_pass` from any specialist becomes a `specialistFailures[]` entry.

UI mapping (`src/pages/agents/contract-review.astro`):

| UI tab | Content |
|---|---|
| Severity row | Counts of Blocker / Major / Moderate / Minor pulled from `reviews.severity_counts` |
| Top 3 | Resolves `priority_three` ids → finding cards |
| All Findings | Filter by severity; ordered Tier-1 → Tier-2, then severity, existential first |
| **Structural** | `isStructuralFinding()` — `location` contains "missing"/"entire agreement", OR `source_text` empty + markup_type insert/annotate, OR markup_type insert with no anchor_text |
| **Coverage** | Grouped by specialist from `coverage_pass_aggregate` |

Severity mapping is identity (no remapping). Internal `Review_Summary.docx` (`lib/review-summary.js`) renders: severity table, specialist failures (warning), Top 3, senior-review callouts, all findings sorted by severity, unanchored findings, coverage pass per specialist, rejected-findings audit trail.

## 6. Document Classification Taxonomy

Recognized contract types (`netlify/agents/document-classifier.md` lines 38-67):

`nda`, `mutual_nda`, `one_way_nda`, `purchase_order`, `order_form`, `quote`, `statement_of_work`, `master_services_agreement`, `subscription_agreement`, `saas_agreement`, `software_license`, `enterprise_license`, `data_processing_agreement`, `business_associate_agreement`, `professional_services`, `consulting_agreement`, `reseller_agreement`, `distribution_agreement`, `referral_agreement`, `lease_equipment`, `lease_real_estate`, `loan_agreement`, `employment_agreement`, `independent_contractor_agreement`, `joint_venture`, `partnership_agreement`, `merger_agreement`, `asset_purchase_agreement`, `stock_purchase_agreement`, `unknown`.

Fallback: classifier `.md` says "If no profile default exists for the contract type, use `standard` as a safe fallback." `start-review.js` defaults to `{ contract_type: 'unclassified', pipeline_mode: 'standard', confidence: 0 }` if classifier throws, and confidence-based guardrails force `standard` whenever confidence <0.4 or `express` requested with confidence <0.85.

## 7. Test Materials

`tools/contract-grader/test_contracts/`
- `msa_reasoning_test.docx` — 4,436-word vendor's-paper SaaS MSA, 75 paragraphs
- `msa_reasoning_test.pdf` — born-digital export of same content (8 pages)

`tools/contract-grader/test_profiles/`
- `profile_buyer_positions.json` — buyer-side profile, customer_side role, full playbook (payment, late fees, liability_cap, indemnification, etc.)
- `profile_empty.json` — DEFAULT_PROFILE-equivalent with no positions
- `playbook_buyer_positions.docx` — same positions rendered as prose for testing the playbook-upload path

`tools/contract-grader/harness.mjs` — runs full pipeline locally bypassing Supabase. Mirrors `processReview` flow verbatim (helpers like `aliasProposedText`, `validateFindingSchema`, `resolveSpecialists` are duplicated for parity). Loads `.env`, stubs Supabase env, forces IPv4 DNS for Win Node 24. Usage: `node harness.mjs <run-label> <contract-path> <profile-path-or-"empty"> <deal-posture>`. Output → `tools/contract-grader/runs/<label>.json`. Companion: `grade_rationales.mjs` LLM-judges and writes `<label>.graded.json`.

Citation-tool corpus equivalent: `netlify/lib/citation-verifier/` is a separate, independent pipeline (extract.js, validators.js, classify-citation.js, court-listener.js, etc.) with its own `__tests__/` directory and `tables/`. Has been iterated through Round 30; **not part of contract-review pipeline**.

## 8. Known Issues / Methodology Learnings

From `REPORT_round_1.md`, `REPORT_round_2.md`, `REPORT_round_3a.md`, `METHODOLOGY.md`:

| Issue | Status |
|---|---|
| **PDF vs DOCX paragraph parity** | Round 2 fix landed: `itemsToParagraphedText()` uses median-y-gap with 1.3× threshold. PDF post-fix: 79 paragraphs vs DOCX's 75. **Shipped.** |
| **EXEMPLARY-rationale gating** | Round 3a established that EXEMPLARY count is high-variance (SD ~2.4 across reruns of identical scenario). **Decision**: do not gate on absolute EXEMPLARY; use multi-run mean ≥1.5×SD or CONTEXTUAL-share as primary quality gate |
| **CONTEXTUAL share** is the cleanest reasoning-quality metric (low variance, comparable across formats) — recommended primary gate |
| **MECHANICAL count** stable but low-volume — directional only |
| **Total-finding count** stable to ±15% — useful for "did the change break the pipeline" |
| **Heading detection in PDF** (R2 hypothesis 5) — section headings flatten as paragraphs, no font-size detection. **Parked** |
| **Definition-list flattening in PDF** (R2 hypothesis 3) — tab-aligned definitions don't survive identically. **Parked** |
| **Punctuation-spacing diff PDF↔DOCX** (R2 hypothesis 4) — possible residual reasoning loss. **Parked** |
| **Empty `coverage_pass` failure mode** | Shipped: `specialistFailures` surfaced both in `findings.json` and Review_Summary.docx |
| **Round 5a/5b — PDF StrikeOut annotations** | Both merged then **reverted today** (commits `350e359`, `a60fa04`). Currently NOT in main |
| **Cost rule of thumb** | ~$0.60–0.85 per single uncached pipeline run; ~$0.30–0.45 cached. ~$0.025 to grade rationales for 25 findings |
| **Rate-limit ceiling** | At observed org tier (90,000 output tokens/min), >3 parallel pipeline runs hit 429s. Use prompt caching or sequential |

Round-budget table in METHODOLOGY.md and the `round-3.5-runs/`, `round-4-runs/`, `round-5c-runs/`, `round-5d-runs/` directories suggest more recent rounds were attempted but only `.log` files exist for some — no `REPORT_round_*.md` published for those, so they appear to be unfinished/parked work.

## 9. Recent Commit History

```
350e359 Revert "Merge Round 5a — PDF StrikeOut annotations + 4 follow-up fixes"  ← today
a60fa04 Revert "Merge Round 5b — multi-page StrikeOut with /IRT linking"        ← today
a654f1e Merge Round 5b — multi-page StrikeOut with /IRT linking
bfbcc00 Round 5b — multi-page StrikeOut with /IRT linking
98ee56a Merge Round 5a — PDF StrikeOut annotations + 4 follow-up fixes
76db4c7 Round 5a fix #4 — multi-line StrikeOut (right-margin overshoot)
c1b6050 Round 5a fix #3 — quad encompasses full text bbox; Font Capture root-caused
36f7f10 Round 5a fix #2 — correct StrikeOut QuadPoints geometry
02d5f1e Round 5a fix — encode annotation Contents/T as proper text strings
bd44b22 Round 5a — PDF StrikeOut annotations for delete findings
36d5ffb Contract-grader methodology doc — variance findings + run-count guidance  ← effective state of main now
ec573c3 Round 3a — variance check confirms ship Round 2
9f509f6 Round 2 — PDF paragraph extraction fix + single-scenario verification
dd174c7 Round 1 — reasoning-verification report + all 14 graded runs
44f4129 Round 1 setup: test contract, profiles, harness, grader
```

**Most recent meaningful work**: contract-review attempted PDF StrikeOut annotations for delete findings (Rounds 5a + 5b) — reached merged state, then reverted today. **Net effect on main: contract-review pipeline is at the Round-3a-shipped state plus the methodology doc.** PDF strikeout work, Round 4 DOCX anchor reliability, and Rounds 5c/5d (positioning + scope guidance) are **not** in main and have been deleted from origin. Citation-verifier work (Rounds 26-30) is unrelated to contract-review and continues independently.
