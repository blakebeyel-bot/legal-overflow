# HANDOFF — Contract Review Platform

This folder is a drop-in contract-review engine. It's meant to be integrated into
the **Legal Overflow** website (hosted on GitHub + Netlify) as a paid/trial
feature for customers.

Everything below is the state of things as handed over. Read the other Claude
Code session's `HANDOFF_PROMPT.md` for the paste-me-in prompt that briefs the
new session quickly.

---

## 1. What this is

A profile-driven AI contract-review pipeline. One JSON file
(`config/company_profile.json`) describes a company's positions, red flags,
voice, and escalation rules. The same pipeline reviews any contract for any
company — the profile customizes it.

User flow:
1. User signs up on the website.
2. User either **uploads their own playbook** (Word / PDF / markdown) or goes
   through a short **chat interview** to build their profile. Both paths produce
   the same `company_profile.json`.
3. User uploads a contract. The platform runs 7–8 specialist AI agents in
   parallel against the profile.
4. User gets back three files: a marked-up contract in its native format, an
   internal review summary, and a structured `findings.json`.

---

## 2. What's in this folder

```
contract-review-platform/
├── CLAUDE.md                         Durable rules — loaded by Claude Code every session
├── README.md                         Developer-facing overview
├── HANDOFF.md                        This file
├── HANDOFF_PROMPT.md                 Paste-me prompt for the new Claude Code chat
├── .gitignore
│
├── config/
│   ├── company_profile.schema.json   JSON schema for the profile
│   ├── company_profile.example.json  Worked example (fictional Helix SaaS company)
│   ├── company_profile.json          Active profile — overwritten per user
│   ├── agent_registry.json           Pipeline modes, which agents run when
│   └── limits.json                   Rate limits, quotas, caching config
│
├── .claude/
│   ├── agents/                       12 agent definitions (Sonnet 4.6)
│   ├── commands/                     /analyze-contract, /configure-workflow
│   └── settings.json
│
├── scripts/
│   ├── extract_document.py           Canonical text extraction
│   ├── markup_pdf.py                 PDF strikethrough + sticky notes
│   ├── markup_docx.py                DOCX native tracked changes + comments
│   └── api_client.py                 Anthropic SDK wrapper (caching + quotas)
│
├── preview/
│   └── index.html                    Self-contained UI demo (Legal Overflow design system)
│
└── test/
    ├── make_fixture.py
    └── sample_saas_contract.docx     Generic SaaS test contract
```

---

## 3. What's already wired

- **12 agents on Sonnet 4.6** (swappable — see `CLAUDE.md` §4.9).
- **Prompt caching** wired in `scripts/api_client.py` — the company profile
  and contract text are marked cacheable so every specialist in the fan-out
  reads them at a 90% discount. Cuts per-review cost by ~60%.
- **Rate limits** in `config/limits.json`:
  - 3 reviews per user per 30-day window (trial tier)
  - 15 messages max for the configurator chat
  - 500K tokens max per single review (runaway protection)
  - 50 MB / 200-page file cap
- **UI preview** at `preview/index.html` implements the Legal Overflow design
  system (Instrument Serif + Geist + JetBrains Mono, emerald accent, italic-em
  underline reveals, grain overlay). Three views: Configure, Review, Archive.
  Includes quota indicator + message counter + playbook-upload fast-track.

---

## 4. What's NOT wired yet (the deployment work)

The preview HTML is a scripted demo — no real backend calls. To go live on the
Legal Overflow site you need:

1. **Netlify Functions** wrapping `scripts/api_client.py` — one function per
   pipeline stage (classify / fanout / compile), or one background function
   running the whole pipeline.
2. **Supabase** for:
   - User auth (email/password or magic link)
   - Postgres tables for users, reviews, quota counters
   - Storage bucket for uploaded contracts + generated output files
3. **Environment variables in Netlify dashboard:**
   - `ANTHROPIC_API_KEY` — the API key (never commit)
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
4. **Frontend wiring** — swap the `preview/index.html` scripted demo fetch
   calls for real `/api/*` endpoints.
5. **Integrate into the Legal Overflow site** — the HTML goes under a route
   like `/review`. Keep the shared nav/footer from the main site.

---

## 5. Key rules — don't break these

From `CLAUDE.md`:

- **Never cite case law** in any output, customer-facing or internal.
  Hallucination risk. Statutes and doctrines by name are fine.
- **Never write severity labels** (`Blocker / Major / Moderate / Minor`) into
  customer-facing margin comments. They're internal only.
- **Never convert file formats.** `.pdf` stays `.pdf`, `.docx` stays `.docx`.
- **Never reference "the profile" or "our playbook"** in customer-facing
  comments. Voice rule is enforced by `review-compiler` and will block the
  deliverable if violated.
- **All agents run on Sonnet 4.6.** Don't silently downgrade to Haiku to save
  tokens — contract review is high-stakes.
- **Prompt caching is non-optional.** The cached profile + contract markers in
  `scripts/api_client.py` stay in. They're free performance + cost wins.

---

## 6. Cost model

Per-review cost on Sonnet 4.6 with caching on: **~$1.00–$1.50**.
Without caching: **~$2.50**. Express-mode (NDAs, POs): **~$0.15–$0.30**.

At trial tier (3 reviews/user/30 days), a user maxing out costs you **~$4.50**.

---

## 7. First milestone on the other side

Before anything else, the new Claude Code session should:

1. Confirm the Legal Overflow site's framework (plain HTML? Astro? Next.js?
   Eleventy?) and where to put the `/review` route.
2. Install `@netlify/functions` and the Anthropic SDK: `npm install
   @anthropic-ai/sdk @supabase/supabase-js`.
3. Create a Supabase project (free tier) and capture the URL + keys.
4. Set up the initial schema (users, reviews, quota — schema in Section 2 of
   `HANDOFF_PROMPT.md`).
5. Write the first Netlify Function (`classify.js`) and wire the preview's
   "demo upload" button to hit it instead of the scripted timer.

Once that loop is closed end-to-end for one agent, the remaining agents are
copy-paste.
