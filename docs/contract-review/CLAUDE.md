# Contract Review Platform — Project Rules

This file is the authoritative source of durable rules for this platform. Claude Code reads it automatically when this directory is the working folder.

## 1. What this project is

A configurable, profile-driven contract-review platform. One configuration file — `config/company_profile.json` — fully describes a company's negotiating positions, red-flag list, voice preferences, escalation contacts, and output conventions. The same pipeline serves any company: specialists read the profile at runtime and render their analysis through it.

When deployed behind a chat UI on a website, end users customize their profile by talking to the `workflow-configurator` agent. No coding, no template editing — the conversation writes JSON.

## 2. Folder layout

```
contract-review-platform/
├── CLAUDE.md                      (this file)
├── README.md
├── config/
│   ├── company_profile.schema.json      (schema for the profile)
│   ├── company_profile.example.json     (worked example — fictional company)
│   ├── company_profile.json             (ACTIVE profile — created per deployment)
│   └── agent_registry.json              (pipeline modes + which agents run)
├── .claude/
│   ├── agents/                    (specialists + meta agents)
│   ├── commands/
│   │   ├── analyze-contract.md    (orchestrator — reads profile, fans out)
│   │   └── configure-workflow.md  (launches the chat interview)
│   └── settings.json
├── scripts/
│   ├── extract_document.py        (canonical text extraction)
│   ├── markup_pdf.py              (PyMuPDF strikethrough + caret + sticky notes)
│   └── markup_docx.py             (OOXML tracked changes + native comments)
├── contracts-incoming/            (drop contracts here)
├── reviews/<YYYY-MM-DD>_<slug>/   (review outputs land here)
└── test/                          (scratchpad for experiments)
```

## 3. How a review runs

1. User provides a contract path — either through `/analyze-contract "path/to/contract.pdf"` or via the web chat interface.
2. The orchestrator loads `config/company_profile.json` and `config/agent_registry.json`.
3. `extract_document.py` produces canonical plain text that specialists will quote from exactly.
4. `document-classifier` inspects the document, picks a pipeline mode (`express`, `standard`, or `comprehensive`), and determines contract type.
5. Specialists fan out in parallel — each one rendered with the company's profile as context. Each returns a JSON `findings` array.
6. `critical-issues-auditor` runs last as a final sweep against the profile's red-flag list.
7. `review-compiler` deduplicates findings, applies tracked-change markup to a copy of the original file (format-in, format-out), and generates an internal review summary.
8. Three outputs land in `reviews/<YYYY-MM-DD>_<slug>/`:
   - `<name>_Annotated.<ext>` — customer-facing, native format.
   - `<name>_Review_Summary.docx` — internal only.
   - `findings.json` — structured findings for audit / web display.

## 4. Universal rules — apply to every review

These rules are platform-level invariants. They apply regardless of company profile.

### 4.1 Voice — customer-facing output

Every annotation written to a customer-facing file must read like senior outside counsel speaking for the company. Cite applicable statutes (using the jurisdiction's preferred statute list in the profile), legal doctrines by name, and standard industry forms where relevant.

**Never** write internal-system language into a customer-facing annotation:
- No references to "the profile," "the playbook," "our baseline," "internal guidance," or any phrase that reveals an internal decision matrix.
- No severity-tier labels (`Blocker`, `Major`, `Moderate`, `Minor`) — those are internal only.
- No mention of the company's internal escalation contacts.

The profile's `voice.forbidden_phrases` list is enforced by the review-compiler — any annotation containing a forbidden phrase blocks the deliverable.

### 4.2 No case citations — anywhere

**Never cite specific case law in any output, customer-facing or internal.** No case names (`*Smith v. Jones*`), no reporter citations (`558 So. 2d 427`), no "See X v. Y", no "the court in X held." Statutes by section number and doctrines by name are fine; specific cases are not.

LLM-generated case citations hallucinate. One bad cite in a customer-facing file damages credibility and can be used adversely. The review-compiler scans for case-citation patterns and blocks the deliverable if any slip through.

### 4.3 Severity tiers — internal only

Severity labels (`Blocker / Major / Moderate / Minor` by default, or whatever the profile's `severity_scheme` overrides to) are a first-class field in `findings.json` and drive the internal review summary. They **never** appear in customer-facing annotations.

### 4.4 Format in = format out

`.pdf` stays `.pdf`. `.docx` stays `.docx`. Never convert between formats — it breaks the counterparty's Accept/Reject workflow and strips formatting.

Only exception: `.doc` (legacy binary Word) may be repaired to `.docx` via LibreOffice headless before review — that's a repair, not a format change. If a file is corrupt, password-locked, or a scanned-image PDF with unreliable OCR, STOP and ask the user rather than silently producing bad output.

### 4.5 Where proposed language goes — differs by format

- **DOCX**: proposed replacement text goes on the document face as native tracked changes (`<w:ins>` adjacent to the `<w:del>` strikethrough for `replace`; standalone `<w:ins>` for `insert`). The counterparty Accepts/Rejects in Word. The comment body contains **only** the legal commentary — never duplicate the replacement inside the comment.
- **PDF**: keep strikethrough / caret as the visible markup. The proposed replacement language lives **inside the sticky-note comment body**, labeled `PROPOSED REPLACEMENT LANGUAGE: ...`. Do not add a FreeText insertion box on the page face — it clutters the document.

### 4.6 Profile-driven agent configuration

Every specialist renders its positions from `config/company_profile.json` at invocation time. Specialists must never hardcode positions. If a review needs a position the profile doesn't cover, the specialist flags this in its output for the workflow-configurator to address.

### 4.7 Scanned-PDF safety

The PDF markup tool refuses to operate on PDFs with less than ~200 characters of extractable text — those are almost certainly scanned images where anchoring redlines would produce wrong placements. When this happens, STOP and tell the user: re-OCR externally, request a native file, or agree to a review-letter-only approach.

### 4.8 Unanchored findings are never silently dropped

If a specialist produces a finding whose `source_text` can't be located in the source file, the compiler records it under a clearly-labeled "Unanchored Findings — Manual Placement Required" section in the internal summary. Do not drop it.

If more than 30% of findings are unanchored, STOP and report — something is wrong with the text extraction or the specialists are using non-matching quotes.

### 4.9 All agents run on Sonnet 4.6

Every specialist, meta-agent, and the review-compiler use `model: claude-sonnet-4-6` in their YAML frontmatter. This is the standard model for this platform — do not silently change it.

### 4.10 Prompt caching and rate limits

The platform has two cost controls that every deployment must honor:

**Prompt caching.** The company profile and the contract text both get marked `cache_control: {"type": "ephemeral"}` in every specialist API call. The first specialist in a fan-out pays the 25% write premium; every subsequent specialist reads at a 90% discount. Implementation lives in `scripts/api_client.py`. Do not remove the cache markers — they cut cost by 60–70% on a standard fan-out and have zero quality impact (the model sees identical tokens either way).

**Rate and usage limits.** All numeric ceilings live in `config/limits.json` and are enforced by `scripts/api_client.py` at the backend:
- **3 reviews per user per 30-day window** (trial tier default; tiers in the same file).
- **15 messages max** for the workflow configurator chat. At 15, the configurator wraps up and saves what it has.
- **500,000 tokens max per single review** as a runaway ceiling (normal is ~365K).
- **50 MB / 200-page** upload cap.

Never bypass these at the orchestrator layer. If a review genuinely needs more headroom, bump the tier, don't shim around the limit.

## 5. Finding schema

Every specialist (except the classifier and configurator) returns a JSON array of findings matching this schema:

```
{
  "category": "commercial | risk_allocation | insurance | performance | termination | protective | compliance | industry | critical",
  "location": "Section reference, e.g. 'Section 9(a), page 4'",
  "source_text": "character-exact text from the contract to strike or anchor to",
  "suggested_text": "text to insert, or empty string if markup_type is 'delete' or 'annotate'",
  "markup_type": "replace | delete | insert | annotate",
  "anchor_text": "text to anchor an insert, or null",
  "external_comment": "margin comment — senior-counsel voice, no profile references",
  "internal_note": "why this matters — profile references allowed, for internal summary only",
  "severity": "Blocker | Major | Moderate | Minor (or per profile.severity_scheme)",
  "profile_refs": ["positions.risk_allocation.rejects[0]", "red_flags.uncapped_liability_any"],
  "requires_senior_review": true | false
}
```

`profile_refs` is a breadcrumb showing which parts of the profile drove the finding. It's surfaced in the internal summary but never in the customer-facing file.

## 6. Classification modes

The document-classifier picks one of three pipeline modes based on contract type, length, and complexity:

- **express**: simple documents (short NDAs, POs, order forms). Triage + compile only.
- **standard**: default for most B2B contracts. Six core specialists fan out, then critical-issues audit.
- **comprehensive**: high-value / regulated / complex. Adds compliance-regulatory analyst and any profile-enabled industry modules.

Profile's `pipeline_mode_defaults` can override routing by contract type.

## 7. Orchestrator guardrails

- Always run `extract_document.py` before spawning specialists so the canonical text matches what the markup tools will later search for.
- Spawn specialists **in parallel** in a single tool-use turn when the pipeline mode says `parallel: true`.
- Spawn `critical-issues-auditor` **last**, after specialists return.
- Always write concatenated findings to `<output-dir>/_working/findings.json` before handing to the review-compiler.
- Never mark a review complete if any `Blocker`-severity finding lacks `requires_senior_review: true`.

## 8. Adding a new specialist or industry module

The `workflow-configurator` agent can scaffold new specialists on demand. When a user asks via chat for a new category the platform doesn't cover, the configurator:

1. Generates a new `.md` agent file from the specialist template.
2. Adds the new specialist to `config/agent_registry.json` under the appropriate pipeline mode(s).
3. Adds a `positions.<new_category>` block to `config/company_profile.json` and interviews the user to fill it in.

New industry modules (beyond the four listed in `agent_registry.json`) are added the same way.

## 9. Where to write outputs

- **Real review** (triggered by `/analyze-contract` or via the web interface) → `reviews/<YYYY-MM-DD>_<contract-slug>/`.
- **Experiment / test / debug** → `test/<descriptive-subfolder>/`. Never leak experimental outputs into `reviews/`.
- If unsure, ask.

## 10. Dependencies

Python 3.10+ with:

```
pip install pymupdf python-docx lxml
```

LibreOffice (for `.doc` → `.docx` repair) is optional; install if legacy Word docs are expected.

Verify:

```
python -c "import pymupdf, docx, lxml; print('ok')"
```

## 11. Invariants a healthy review holds

- Customer-facing file contains zero: severity labels, profile references, case citations, internal system language, forbidden phrases.
- Internal summary contains profile references (that's allowed there) and zero case citations.
- Every finding with `requires_senior_review: true` is surfaced at the top of the internal summary and in the chat/web response.
- The annotated file opens cleanly in its native app (Word for DOCX, Acrobat/Preview for PDF).
- `findings.json` is valid JSON and matches the finding schema for every specialist.

## 12. How to add or change a rule

If a rule changes:

1. Edit this file (`CLAUDE.md`) so the rule is durable.
2. If it affects specialists, update the relevant `.claude/agents/*.md` so the agent's own system prompt reflects it.
3. If it affects pipeline flow, update `.claude/commands/analyze-contract.md` and `config/agent_registry.json`.
4. If it affects output format, update `scripts/markup_pdf.py` and/or `scripts/markup_docx.py` and the review-compiler.

Durable rules live in this folder and travel with the project. Personal preferences unrelated to the platform may go to user-home memory.
