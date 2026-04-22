# Contract Review Platform

A configurable, profile-driven contract-review pipeline. One JSON file describes a company's negotiating positions, red flags, voice, and escalation rules — the same pipeline serves any company.

## What it does

Give it a contract (PDF or DOCX). Get back:

1. **A marked-up copy in the original format** with tracked changes, strikethroughs, insertions, and margin comments suitable for sending to a counterparty.
2. **An internal review summary** listing every finding with severity, rationale, and escalation flags.
3. **A structured `findings.json`** for audit trail and for display in a web UI.

## How it works

```
Contract file
    ↓
extract_document.py         → canonical plain text
    ↓
document-classifier         → picks pipeline mode + contract type
    ↓
Specialist fan-out          ← reads company_profile.json
  (parallel)
  • commercial-terms-analyst
  • risk-allocation-analyst
  • insurance-coverage-analyst
  • performance-obligations-analyst
  • termination-remedies-analyst
  • protective-provisions-analyst
  • compliance-regulatory-analyst  (comprehensive mode)
  • industry modules              (profile-enabled)
    ↓
critical-issues-auditor     → final sweep for red flags
    ↓
review-compiler             → applies tracked changes / PDF markup
                              + writes internal summary
    ↓
reviews/<date>_<slug>/
  • <name>_Annotated.<ext>
  • <name>_Review_Summary.docx
  • findings.json
```

## Quick start

### 1. Install dependencies

```
pip install pymupdf python-docx lxml
```

### 2. Configure your company profile

Option A — talk to the workflow-configurator agent:
```
/configure-workflow
```

It interviews you conversationally and writes `config/company_profile.json`.

Option B — copy the example and edit by hand:
```
cp config/company_profile.example.json config/company_profile.json
```

Edit to reflect your company's name, jurisdiction, positions, red flags, escalation contacts, and voice preferences.

### 3. Review a contract

```
/analyze-contract "path/to/contract.pdf"
```

Or drop the contract into `contracts-incoming/` and run:

```
/analyze-contract "contracts-incoming/some-contract.pdf"
```

Outputs land in `reviews/<YYYY-MM-DD>_<slug>/`.

## Configuration

Everything company-specific lives in `config/company_profile.json`. The schema is at `config/company_profile.schema.json`. A fully worked example is at `config/company_profile.example.json` (fictional B2B SaaS company).

**Key fields:**

| Field | What it drives |
|---|---|
| `company` | Name, industry, default role label (Provider / Vendor / Contractor / etc.) |
| `jurisdiction` | Governing-law preferences, which statutes specialists cite |
| `positions` | Per-category (accepts / rejects / negotiates) used by each specialist |
| `red_flags` | The critical-issues-auditor scans for these |
| `escalation` | Who gets flagged when |
| `voice` | Tone, labels, citation preferences, forbidden phrases |
| `output` | File naming conventions, author attribution |
| `enabled_modules` | Which industry modules join comprehensive-mode runs |

Change the profile → next review uses the new positions. No code changes.

## Adding a new specialist or category

Ask the workflow-configurator:

> "Add a specialist for data-processing agreements."

It scaffolds a new agent file, adds it to `config/agent_registry.json`, interviews you for the positions, and writes them to the profile. The new specialist joins the next review.

## Safety rules

- **No case citations.** LLM-generated case cites hallucinate. Statutes and doctrine names are fine; specific cases are blocked.
- **No internal system language in customer-facing output.** The compiler scans for forbidden phrases and blocks the deliverable if any slip through.
- **No format conversion.** PDF stays PDF, DOCX stays DOCX.
- **Scanned PDFs refused.** Under ~200 chars of extractable text → STOP and ask for a native file.
- **Unanchored findings preserved.** Any finding whose quote can't be located is recorded in the internal summary for manual placement. If more than 30% of findings are unanchored, the pipeline stops and reports.

## Deployment note

This project is self-contained. To continue developing it elsewhere in Claude Code, zip the folder, copy it, install dependencies (`pip install pymupdf python-docx lxml anthropic`), and open it as your working directory.

To deploy to a live website (Netlify + Supabase stack): see **HANDOFF.md** for the full architecture and **HANDOFF_PROMPT.md** for the paste-me-in prompt that briefs a new Claude Code session connected to your production repo.

## Preview

A self-contained UI demo lives at `preview/index.html` and matches the Legal Overflow design system (Instrument Serif + Geist + JetBrains Mono, emerald accent, grain overlay). To view it locally:

```
python -m http.server 8000 --directory preview
```

Then open http://localhost:8000.

The preview is scripted — no real API calls. Hook it to Netlify Functions + Supabase for production (see HANDOFF_PROMPT.md).
