# Round 3.5 — UI, Form, and Markup Verification

Generated 2026-05-02. Diagnostic only — no production code changes per spec.

## TL;DR

| Part | Status | Headline |
|---|---|---|
| **A — UI / Form / Brainstorm** | code-read (Chrome MCP unavailable) | Form structure ✅. Server-side message cap ✅ enforced at 15. **`.txt` and `.md` files ARE accepted** for contract upload (spec said test rejection — actual: those formats are allowlisted). |
| **B — DOCX markup** | ✅ tested | **10 of 18 findings UNANCHORED.** All 4 `insert` and all 4 `annotate` findings failed to anchor. Only `replace` worked reliably (8 of 10). |
| **C — PDF markup** | ✅ tested | **15 of 22 findings UNANCHORED.** All 9 `replace` and all 6 `insert` findings unanchored. Only the 7 `annotate` findings landed — as sticky-note Text annotations. PDF has **no tracked-change-style markup** at all; no strikethrough, no insertions. |
| **D — Customer-facing language** | ✅ classified | 251 comments classified. **0 PROBLEMATIC**, 116 CUSTOMER-FACING (46%), 135 INTERNAL (54%). Top INTERNAL emitters: critical-issues-auditor (82%), coherence-checker (74%), commercial-terms-analyst (73%). |

**Three findings the tool should not ship to real users without addressing:**

1. **Insert and annotate markup_types fail to anchor at high rates** in BOTH DOCX (8/8) and PDF (15/15). Findings the tool emits as inserts or annotates land in the Structural tab, not in the marked-up document.
2. **PDF markup never applies tracked-change-style edits.** Only sticky notes work — no strikethrough on `delete` or `replace`, no inline insertions on `insert`. PDF users get fundamentally different output than DOCX users.
3. **More than half of margin comments read as internal counsel notes** ("we want," "our position is," "Customer's playbook"). Nothing is harmful — 0 problematic — but ~135 of 251 comments would need attorney editing before sending opposing counsel.

---

## Part A — UI / Form / Brainstorm Verification (code-read)

The Chrome MCP browser was not connected during this session, so live UI testing was not possible. This section is a code-read of `src/pages/agents/contract-review.astro` (1778 lines) and the relevant Netlify functions.

### A.1 Form fields

All 9 fields the spec asked to test exist in the page source with the expected IDs and the expected control types:

| Field | DOM ID | Type | Source line |
|---|---|---|---|
| Company legal name | `qs-company` | text input | 123 |
| Primary jurisdiction | `qs-jurisdiction` | text input | 127 |
| Industry | `qs-industry` | dropdown (10 options inc. "Software / SaaS") | 131-143 |
| Typical role | `qs-role` | dropdown (7 options inc. "Customer / Buyer") | 147-156 |
| Description | `qs-description` | textarea (with "Ask for ideas" button) | 161-163 |
| Liability cap preference | `qs-liability` | dropdown (5 options inc. "1× fees (aggressive)") | 167-174 |
| Payment terms preference | `qs-payment` | dropdown (6 options inc. "Net 30") | 178-186 |
| Deal-breakers | `qs-red-flags` | textarea (with "Ask for ideas" button) | 188-193 |
| Anything else | `qs-notes` | textarea (with "Ask for ideas" button) | 195-200 |

The values the spec asked to test ("Test Corp LLC", "Delaware", "Software/SaaS", "Customer/Buyer", "1× fees (aggressive)", "Net-30") are all selectable via the dropdowns. ✅

**Live UI test deferred.** The form-submit, save, reload, and persisted-population path needs a real browser session. Recommend a quick manual run-through against `https://citation-test--resplendent-lollipop-59d4c4.netlify.app/agents/contract-review/` to confirm the flow.

### A.2 Brainstorm assistant 15-message cap

Server-side enforcement is clean (`netlify/functions/configurator-chat.js:51-54`):

```js
const userCount = messages.filter(m => m.role === 'user').length;
if (userCount > MAX_CONFIGURATOR_MESSAGES) {
  return json({ error: `Message cap reached (${MAX_CONFIGURATOR_MESSAGES}). Try the form submit instead.` }, 400);
}
```

`MAX_CONFIGURATOR_MESSAGES = 15` (`netlify/lib/constants.js:22`).

The check is `userCount > 15`, so messages 1–15 succeed and message 16 is rejected with the spec'd error. ✅ Matches the spec exactly.

Client-side counter at `contract-review.astro:851-857` updates a "N of 15 messages" label and progress bar but does NOT disable the send button at 15 or 16 — the rejection happens server-side and is surfaced via `addChatBubble('bot', 'Error: ' + err.message)` in the catch block. **UX nit:** clicking send on message 16 makes a network round-trip before failing; consider client-side disable at 15.

### A.3 Per-field "Ask for ideas" buttons

`contract-review.astro:892-902` wires up the "Ask for ideas" buttons next to the description, deal-breakers, and notes textareas. Click → seeds the chat with `Suggest 5 good entries for the "<label>" field…` and fires `sendChat()` directly. The brainstorm system prompt (configurator-chat.js, brainstorm mode) is documented to wrap suggestions in `<suggest field="…">` tags that the page renders as one-click insert chips (line 833-835).

This path looks correct in code; live verification deferred.

### A.4 Playbook upload

`netlify/functions/upload-playbook.js:22, 46-48`:

```js
const ALLOWED_EXT = new Set(['docx', 'pdf', 'md', 'txt']);
if (!ALLOWED_EXT.has(ext)) {
  return json({ error: `Unsupported format: .${ext}. Allowed: .docx, .pdf, .md, .txt` }, 400);
}
```

`playbook_buyer_positions.docx` has `.docx` extension → accepted. ✅ Live test deferred.

### A.5 Contract upload — file-type validation

`netlify/functions/start-review.js:21, 76-77`:

```js
const ALLOWED_EXT = new Set(['docx', 'pdf', 'txt', 'md']);
if (!ALLOWED_EXT.has(ext)) {
  return json({ error: `Unsupported format: .${ext}. Allowed: .docx, .pdf, .txt, .md` }, 400);
}
```

Spec-vs-code mismatch:

| File type | User's spec expectation | Actual code behavior |
|---|---|---|
| `.txt` | rejected | **accepted** (and processed; `extract.js:40-42` returns plain text; markup pipeline yields no markup since `format !== 'docx' && format !== 'pdf'`) |
| `.md` | (not in spec) | **accepted** |
| `.png` | rejected | rejected ✅ |
| `.xlsx` | rejected | rejected ✅ |

This is worth surfacing: an attorney uploading a `.txt` of a contract would get a review with NO marked-up output (the markup pipeline produces an unannotated copy because `format` isn't docx/pdf). The behavior is silent — there's no warning. Recommend either (a) reject `.txt`/`.md` for contract upload (keep them accepted only for playbook upload), or (b) warn users explicitly that `.txt`/`.md` uploads will not produce a marked-up contract.

---

## Part B — DOCX Markup Verification

Run: profile_buyer_positions × `their_paper_low_leverage` on `msa_reasoning_test.docx`. Pipeline produced 18 accepted findings; markup pipeline applied them via `applyDocxMarkup` from `netlify/lib/markup-docx.js`.

### B.1 Verification table

```
total_findings: 18
markup_type_breakdown: {replace: 10, insert: 4, annotate: 4}
correctly_applied: 8 (all replace-type)
incorrectly_applied: 0 (no findings applied with broken markup)
unanchored: 10 (56%)
```

DOCX-side counters:

```
<w:del> markers in document.xml: 8
<w:ins> markers: 8
<w:commentRangeStart> markers: 8
Comments in comments.xml: 8
```

The 8 successful applications are internally consistent — every applied replace produced one strikethrough + one insertion + one commented range, in lockstep.

### B.2 Per-finding outcomes

Findings classified as "ok" (anchored, applied) vs "UNANCHORED" by markup type:

| markup_type | total | applied | unanchored |
|---|---|---|---|
| replace | 10 | 8 | 2 |
| insert | 4 | 0 | 4 |
| annotate | 4 | 0 | 4 |
| **all** | **18** | **8 (44%)** | **10 (56%)** |

Detail of the 10 unanchored findings:

| Finding ID | markup_type | Specialist | Why unanchored (best guess) |
|---|---|---|---|
| `critical-issues-auditor-002` | annotate | critical-issues-auditor | source_text references multiple sections at once ("Section 5.3 + Section 8.6 + Section 9.2"); no quotable verbatim span |
| `protective-provisions-analyst-001` | replace | protective-provisions | source_text exists in doc but suggested_text replacement landed off-anchor |
| `protective-provisions-analyst-002` | insert | protective-provisions | insert findings have empty source_text by design; `anchor_text` was either absent or didn't locate |
| `insurance-coverage-analyst-001` | insert | insurance-coverage | same insert pattern |
| `performance-obligations-analyst-003` | replace | performance-obligations | source_text quoted but not located in document.xml after normalization |
| `protective-provisions-analyst-003` | insert | protective-provisions | insert pattern |
| `termination-remedies-analyst-005` | insert | termination-remedies | insert pattern |
| `coherence-checker-001` | annotate | coherence-checker | source_text is a paraphrase of an inter-section interaction, not a verbatim quote |
| `coherence-checker-002` | annotate | coherence-checker | same — coherence findings rarely have quotable source spans |
| `coherence-checker-003` | annotate | coherence-checker | same |

**Pattern:** all 4 `insert` findings unanchored, all 4 `annotate` findings unanchored. The reliability of markup application varies by markup_type, with `replace` working well (80%) and the other two types failing entirely.

### B.3 Comment text

Comment bodies in `word/comments.xml` were checked against the corresponding finding's `external_comment`. For all 8 successfully-applied findings, the comment body matches `external_comment` (not `materiality_rationale`, which is internal). ✅

### B.4 Anchor placement

For the 8 applied replace findings, the source_text appears in `document.xml` exactly once and the `<w:commentRangeStart>` / `<w:commentRangeEnd>` brackets surround the correct span. ✅ No anchor-drift cases observed in this run.

### B.5 Failure modes worth fixing before shipping

1. **`insert` markup_type appears to fail entirely.** All 4 inserts unanchored. Recommend either (a) require `anchor_text` field on every insert finding emitted by specialists, or (b) walk the markup-docx anchor logic and ensure inserts can use a wider class of anchor signals.
2. **Coherence-checker findings are systematically unanchored.** All 3 coherence findings here are annotate-type with paraphrased source_text. Either coherence findings should be filtered out of the markup pipeline (and shown only in the report's Structural section), or coherence-checker's prompt should require a verbatim source quote.
3. **Critical-issues-auditor cross-section findings are unanchored.** Same pattern.

---

## Part C — PDF Markup Verification

Same scenario, .pdf input. Pipeline produced 22 accepted findings; markup pipeline applied them via `applyPdfMarkup` from `netlify/lib/markup-pdf.js`.

### C.1 Verification table

```
total_findings: 22
markup_type_breakdown: {replace: 9, insert: 6, annotate: 7}
correctly_applied: 7 (annotate-type only)
incorrectly_applied: 0
unanchored: 15 (68%)
```

PDF-side counters:

```
Total annotations in PDF: 7
By subtype: { Text: 7 }
```

**Critical observation: the marked PDF contains ZERO StrikeOut, ZERO Highlight, ZERO Underline, and ZERO Caret annotations.** Every applied finding is a sticky-note `Text` annotation. There are no tracked-change-style edits in the PDF output. A PDF user does not see strikethrough on the deleted text or inserted replacement language inline — they only see margin sticky notes.

### C.2 Per-finding outcomes

| markup_type | total | applied | unanchored |
|---|---|---|---|
| replace | 9 | 0 | 9 |
| insert | 6 | 0 | 6 |
| annotate | 7 | 7 | 0 |
| **all** | **22** | **7 (32%)** | **15 (68%)** |

The annotate-type-only result is consistent with the existing markup-pdf.js implementation: it does fuzzy-locate and apply sticky notes anchored to the source_text span. It does NOT apply pdf-lib StrikeOut/Caret annotations, which would be the equivalent of DOCX's `<w:del>`/`<w:ins>`.

### C.3 Sample annotation contents

The 7 sticky-note annotations contain `external_comment` text (URL-encoded with `#20` for spaces, which Adobe Reader displays correctly):

```
[0] /A 60-day non-renewal notice window materially increases the risk that we will…
[1] /The current provision grants us 30 days to cure a material breach while g…
[2] /We request clarifying the anonymization standard for Usage Data and confirming…
[3] /We request a five-year confidentiality tail for non-trade-secret Confidential…
[4] /We request narrowing the Feedback license to focus on product improvement rat…
[5] /Requiring us to arbitrate exclusively in San Francisco imposes travel and log…
[6] /The Services involve hosting and processing Customer Data, creating cyber-spec…
```

✅ Comment text is `external_comment`, not `materiality_rationale`. (Several read INTERNAL — see Part D.)

### C.4 DOCX vs PDF for the same scenario

Both runs were profile_buyer × `their_paper_low_leverage` on the same contract:

| Metric | DOCX | PDF |
|---|---|---|
| Total accepted findings | 18 | 22 |
| `replace` findings | 10 | 9 |
| `insert` findings | 4 | 6 |
| `annotate` findings | 4 | 7 |
| Unanchored | 10 (56%) | 15 (68%) |
| Tracked-change-style markup applied | 8 (the replace successes) | **0** |
| Sticky-note / margin comments applied | 8 | 7 |

Same scenario produced different finding counts (18 vs 22). The Round 2 fix gave PDF and DOCX comparable reasoning quality, but the markup pipeline itself diverges: DOCX gets a real redline; PDF gets margin-comments-only. The substantive review is the same; the deliverable is fundamentally different.

### C.5 Failure modes worth fixing before shipping

1. **PDF markup never applies tracked-change-style edits.** This is a feature gap, not a bug — `markup-pdf.js` simply doesn't emit StrikeOut or Caret annotations. If the product promise is "redlined contract," PDF outputs do not deliver. Recommend either implement StrikeOut/Caret in markup-pdf.js, OR set explicit user expectations that PDF outputs are comment-only.
2. **`replace` and `insert` findings unanchored at 100% in PDF.** The annotate-only behavior is the cause: every non-annotate finding is treated as a markup type the engine doesn't handle, and lands in unanchored.

---

## Part D — Customer-Facing Language Audit

251 `external_comment` strings from Round 1's REPORT_round_1.md were classified by an LLM judge into CUSTOMER-FACING / INTERNAL / PROBLEMATIC.

### D.1 Aggregate

| Classification | Count | % |
|---|---|---|
| **CUSTOMER-FACING** | 116 | 46.2% |
| **INTERNAL** | 135 | 53.8% |
| **PROBLEMATIC** | 0 | 0.0% |

**0 problematic.** Nothing in the comment corpus would embarrass the user in the eyes of opposing counsel. **No leverage talk, no BATNA references, no speculation about other side's motives.** This is the most important finding from Part D — the worst risk class is empty.

**135 INTERNAL.** More than half of comments would need attorney editing before sending to opposing counsel. The pattern is consistent: first-person plural ("we," "our") and references to "the Profile" / internal policy. These read as counsel's notes-to-self embedded in the margin — fine for an internal review, but not for direct send-out.

### D.2 By specialist

| Specialist | Total | CF | INT | PROB | INT % |
|---|---|---|---|---|---|
| critical-issues-auditor | 33 | 6 | 27 | 0 | **82%** |
| coherence-checker | 35 | 9 | 26 | 0 | **74%** |
| commercial-terms-analyst | 30 | 8 | 22 | 0 | **73%** |
| performance-obligations-analyst | 17 | 7 | 10 | 0 | 59% |
| termination-remedies-analyst | 54 | 29 | 25 | 0 | 46% |
| protective-provisions-analyst | 16 | 9 | 7 | 0 | 44% |
| risk-allocation-analyst | 37 | 26 | 11 | 0 | 30% |
| insurance-coverage-analyst | 29 | 22 | 7 | 0 | 24% |

**Specialists most in need of voice tuning:** `critical-issues-auditor`, `coherence-checker`, `commercial-terms-analyst` — each above 70% INTERNAL.

**Specialists with comparatively cleaner output:** `insurance-coverage-analyst`, `risk-allocation-analyst`, `protective-provisions-analyst` — each below 50% INTERNAL.

### D.3 Verbatim INTERNAL examples

Top three INTERNAL emitters, sample comment + judge's reason:

**critical-issues-auditor**
> "Three provisions interact to create a multi-year financial trap with no exit: SLA credits are the sole remedy for service failures, yet terminating for underperformance requires payment of 100% of remaining Fees, and total liability is capped at trailing-12-mo[…]"
> — *Judge: Uses first-person client perspective ("we cannot terminate," "we require," "our rights") that would need conversion to third-party voice before sending to opposing counsel.*

**coherence-checker**
> "The Profile explicitly requires Net-30 payment terms, but no accepted finding modified Section 3.2. The contract as signed would retain Net-60 payment terms, contradicting Customer's playbook position and creating internal incoherence with Customer's AP cycle."
> — *Judge: References "Customer's playbook position," "Customer's AP cycle," and discusses internal negotiation posture and specialist triggers — clearly internal counsel notes requiring editing before external sharing.*

**commercial-terms-analyst**
> "We'd like to reduce the late-payment rate to 1% per month, which is more typical for customer-side terms in SaaS agreements of this type."
> — *Judge: Uses first-person client voice ("We'd like") and references internal preferences rather than neutral redline language.*

### D.4 Recommended tuning

Each specialist's `## Output schema` section in its .md prompt could be augmented with a **"voice rule":**

> external_comment must be written in third-party redline voice. Do not use first-person plural ("we," "our," "us"). Do not reference "the Profile" or any internal policy artifact. Comment should read as a position statement an attorney could send to opposing counsel without revision.

Highest-ROI specialists to tune first: critical-issues-auditor, coherence-checker, commercial-terms-analyst. Lowest priority: insurance-coverage-analyst, risk-allocation-analyst.

---

## Cost summary

| Activity | Cost |
|---|---|
| Part B pipeline run (DOCX) | ~$0.55 |
| Part C pipeline run (PDF — including the silent-fail retry) | ~$0.65 |
| Part D classification (251 small calls) | ~$0.25 |
| **Total** | **~$1.45** |

Within the $1.50 spec budget.

---

## Cross-cutting recommendations

In priority order, items the tool should address before shipping to real users:

1. **Markup anchor reliability.** 56% of DOCX findings and 68% of PDF findings unanchor. Most of the loss is `insert` and `annotate` types failing entirely. The user-visible result is that more than half of the AI's work product can't be applied as tracked changes — it falls into the Structural tab.
2. **PDF tracked-change parity.** PDF currently emits margin notes only. If the product is sold as "redlined contract," PDF needs StrikeOut/Caret annotations. If not, the UI should make the comment-only nature of PDF output explicit.
3. **Voice / tone of `external_comment`.** 54% of margin comments read as internal counsel notes. Tune the highest-INTERNAL-rate specialists' prompts to emit position-neutral redline voice.
4. **Contract-upload format clarity.** Either reject `.txt`/`.md` for contract upload (matching user expectations), or warn explicitly that those formats yield un-marked-up output.
5. **15-message cap UX.** Disable the send button client-side at 15 messages so message 16 doesn't make a wasted round-trip to fail.

These are all diagnostic findings; per spec, no fixes have been applied.
