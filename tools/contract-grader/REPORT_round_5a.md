# Round 5a — PDF StrikeOut annotations for `delete` findings

**Branch:** `round-5a-pdf-strikethrough`
**Date:** 2026-04-30
**Cost:** ~$0.00 (no pipeline runs needed; verification used handcrafted synthetic findings)
**Status:** Architectural pass; awaiting user-side Adobe Acrobat visual verification.

## Goal

Replace the drawn-red-line "visual strikethrough" used for `markup_type === 'delete'` PDF findings with a proper PDF text-markup annotation (`/Subtype /StrikeOut`). Real annotations render natively with Accept/Reject UI in Acrobat, Foxit, and Preview, and are discoverable by other PDF tooling that walks the annotation array.

Scope intentionally narrow per the round spec:

- `delete` markup_type only. `replace` and `insert` keep their drawn-line behavior unchanged (paired insertion annotation for `replace` is deferred to Round 5c).
- Single-line text only. Wrapped runs would need multiple QuadPoint quadrilaterals (Round 5b).
- Single-page text only.

## Library choice

**pdf-lib (already a dep). No new packages added.** The existing `markup-pdf.js` already uses pdf-lib for writing and pdfjs-dist for text positions, and pdf-lib's `PDFContext` exposes the low-level dict-creation primitives needed to write a PDF 1.7 §12.5.6.10 text-markup annotation directly. The pre-existing `addTextAnnotation()` helper (sticky notes) uses the same low-level pattern, so the new `addStrikeOutAnnotation()` slots in cleanly with no new lift.

## Implementation

Two changes to `netlify/lib/markup-pdf.js`:

1. **Branch split (line ~77).** The single `replace || delete` branch that drew a red line was split into separate handlers. `delete` now calls `addStrikeOutAnnotation()`; `replace` retains the existing `page.drawLine` for now.

2. **New helper `addStrikeOutAnnotation()`** at the end of the file. Builds a real annotation dict:
   ```
   /Type /Annot
   /Subtype /StrikeOut
   /Rect    [llx lly urx ury]
   /QuadPoints [x1 y1 x2 y2 x3 y3 x4 y4]    % TL, TR, BL, BR per spec
   /C       [0.85 0.20 0.20]                % red, matches old line color
   /F       4                                % Print flag
   /CA      0.85                             % constant opacity
   /Contents (<external_comment>)
   /T       (Legal Overflow)
   ```
   The annotation ref is then pushed onto the page's `/Annots` array, exactly the same handoff the existing `addTextAnnotation()` uses.

QuadPoints uses the spec's TL/TR/BL/BR ordering. Acrobat is the reference viewer for that ordering; some other viewers also accept TL/TR/BR/BL but the spec's order is what we wrote.

The sticky-note (`addTextAnnotation`) call still fires in addition to the StrikeOut, so the popup `external_comment` is still attached as before — Round 5a did not remove sticky notes for `delete`. Acrobat will show two annotations on the same text: the StrikeOut (with its own popup) and the offset Text sticky. We can decide in 5b/5c whether to fold the comment INTO the StrikeOut's `/Contents` and drop the separate sticky for `delete`.

## Verification

Real specialists rarely emit `markup_type === 'delete'` (R3.5 PDF run produced **0** delete findings out of 22; even R3.5 DOCX produced 0). Running a fresh pipeline to "see if any delete findings emerge organically" is therefore an unreliable test of the code path. Instead I built **handcrafted synthetic findings** at `tools/contract-grader/round-5a-runs/synthetic-delete-findings.json` — 4 `delete` findings targeting known single-line text in `msa_reasoning_test.pdf`:

| # | Source text | Comment summary |
|---|---|---|
| 1 | "one and one-half percent (1.5%) per month" | Above buyer's late-fee cap |
| 2 | "non-exclusive, non-transferable, non-sublicensable" | Triple restriction is over-restrictive |
| 3 | "in its sole discretion" | Vendor-favorable absolute discretion |
| 4 | "thirty (30) days overdue" | Aggressive suspension trigger |

### Pipeline result

```
node tools/contract-grader/apply_markup.mjs \
  tools/contract-grader/round-5a-runs/synthetic-delete-findings.json \
  tools/contract-grader/test_contracts/msa_reasoning_test.pdf \
  tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf

[apply_markup] 4 findings → .../synthetic-delete-marked.pdf
[apply_markup] unanchored: 0
```

All 4 anchored. Now parse the output PDF back with pdf-lib:

```
node tools/contract-grader/inspect_pdf_markup.mjs ...

Total annotations: 8
By subtype: { StrikeOut: 4, Text: 4 }
Markup types: { delete: 4 }
Unanchored: 0
```

**4 StrikeOut + 4 Text** — exactly the expected shape (1 StrikeOut over the deleted text + 1 Text sticky for the comment popup, per finding).

### Field-level annotation correctness

A deeper read of each StrikeOut annotation confirmed:

- `Rect` is a 4-number bounding box `[llx, lly, urx, ury]` matching the text run.
- `QuadPoints` is 8 numbers (TL.x, TL.y, TR.x, TR.y, BL.x, BL.y, BR.x, BR.y), the PDF 1.7 spec ordering.
- `C` = `[0.85, 0.2, 0.2]` (red).
- `F` = 4 (Print flag).
- `CA` = 0.85 (constant opacity).
- `Contents` carries the per-finding `external_comment`.
- `T` carries author "Legal Overflow".

### Adobe Acrobat verification (user task)

The sandbox environment doesn't have Acrobat. The deliverable PDF for manual visual verification is:

```
tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf
```

Pass conditions (per round spec) for the user to confirm in Acrobat:

- All 4 strike-throughs appear on the correct text.
- Each strike-through is hover-visible with the `external_comment` in its popup.
- Acrobat's Comments panel shows them as Strikethrough annotations (not freeform drawings) with Accept/Reject context-menu options.
- No regression on existing sticky-note comments (the 4 Text annotations should still appear).

## Pass / fail

| Condition | Status |
|---|---|
| 100% of `delete` findings produce real `/Subtype /StrikeOut` annotations | ✅ verified via pdf-lib parse-back (4/4) |
| Annotations include `external_comment` in `/Contents` | ✅ verified |
| No regression on sticky-note comments | ✅ verified — 4 Text sticky-notes still present |
| Visual rendering correct in Acrobat | ⏳ pending user verification |

## Pre-existing finding worth noting

`Contents` and `T` come back from pdf-lib's `ctx.obj(string)` as PDFName objects (with `#20` for spaces) rather than PDFString literals. This matches what `addTextAnnotation()` has done since Round 1 — the existing sticky notes have been encoded the same way and have rendered correctly in production for citation-test users. Real viewers decode the Name back to readable text in the popup.

If we ever see a viewer that displays raw `Vendor-favorable#20absolute-discretion` in a comment popup, the fix is to switch both helpers to `PDFHexString.of(string)` or `PDFString.of(string)`. **Out of scope for Round 5a** — fixing it here would change behavior for the existing sticky-note path that's been shipping.

## Round 5b / 5c plan (carry-forward notes)

- **Round 5b — multi-line StrikeOut.** When the anchor text wraps across lines, `findTextHits()` currently returns one bounding box that may span multiple lines visually. The fix is: detect line breaks in the matched run (gap in y-coordinate between consecutive pdfjs items inside the match) and emit one quadrilateral per line, concatenated into a single `QuadPoints` array. Per spec, `QuadPoints` is a flat array of 8N numbers (N quadrilaterals). Single annotation, multi-line strikethrough.
- **Round 5b — multi-page.** When the anchor text spans a page break, emit two annotations (one per page) and link them via `/IRT` (in-reply-to) so they appear as a thread.
- **Round 5c — `replace` as paired StrikeOut + insertion.** `replace` should produce a real StrikeOut over the source_text *and* an "insertion" — either a `Caret` annotation at the end with the suggested_text in its popup, or a `FreeText` callout with the suggestion. We'll need to choose between these two on visual-quality grounds in 5c. Today's drawn-line behavior is preserved until then.
- **Encoding cleanup.** Migrate both `addTextAnnotation` and `addStrikeOutAnnotation` from `ctx.obj(string)` → `PDFHexString.of(string)` for `/Contents` and `/T` if any viewer compatibility issue surfaces.

## Files changed

- `netlify/lib/markup-pdf.js` — split `delete`/`replace` branches; added `addStrikeOutAnnotation()` helper.
- `tools/contract-grader/round-5a-runs/synthetic-delete-findings.json` — new, 4 handcrafted delete findings.
- `tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf` — output for Acrobat visual review.
- `tools/contract-grader/round-5a-runs/synthetic-delete-marked.inspection.json` — programmatic inspection result.
- `tools/contract-grader/apply_markup.mjs` — restored from prior round (was deleted on this branch's main parent).
- `tools/contract-grader/inspect_pdf_markup.mjs` — same.
- `tools/contract-grader/REPORT_round_5a.md` — this file.

## Methodology note (for METHODOLOGY.md update)

When a markup_type is one specialists rarely emit (e.g., `delete` in current pipelines), use **handcrafted synthetic findings** to exercise the code path rather than running pipelines hoping the right type appears. Cost: $0 vs $0.50–$0.85 per pipeline run, and avoids non-deterministic test outcomes where the code path may not even fire.
