# Round 5a — PDF StrikeOut annotations for `delete` findings

**Branch:** `round-5a-pdf-strikethrough`
**Date:** 2026-04-30
**Cost:** ~$0.00 (no pipeline runs needed; verification used handcrafted synthetic findings)
**Status:** Architectural pass + three Acrobat-blocking issues addressed (string encoding, QuadPoints baseline-only quad, QuadPoints quad now encompasses full text bbox). Plus root-caused but unrelated "Font Capture" Acrobat popup. Awaiting user comparison vs Adobe's native Strikethrough tool.

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

## Acrobat-blocking fix — string encoding (PDF 1.7 §7.9.2)

The first pass of Round 5a opened cleanly in pdf-lib parse-back but Adobe Acrobat refused to parse it with: **"Expected a string object."**

### Diagnostic

`pdf-lib`'s low-level `ctx.obj(string)` returns a **PDFName**, not a PDFString — Names are the dominant string-shaped type in PDF dicts (`/Type /Annot`, `/Subtype /StrikeOut`, etc.) so the constructor defaults to that. Inspecting the marked PDF programmatically with `lookup → .get(PDFName.of('Contents'))` showed:

```
StrikeOut | Contents class: PDFName  | value: /Triple-restriction#20phrasing#20is#20duplicative#20…
StrikeOut | T        class: PDFName  | value: /Legal#20Overflow
Text      | Contents class: PDFName  | value: /Triple-restriction#20phrasing#20is#20duplicative#20…
Text      | T        class: PDFName  | value: /Legal#20Overflow
```

The leading `/` and `#20`-encoded spaces are the giveaway: those are PDF Name-object encodings. PDF 1.7 §12.5.6.4 (annotation `Contents` field) and §12.5.6.4 (`T` author field) require **text string objects**, defined in §7.9.2 as either:

- a literal string `(...)` (PDFDocEncoding-compatible), or
- a hex string `<...>` (UTF-16BE with optional FEFF BOM for Unicode).

Acrobat is strict here. Other viewers (Apple Preview, Chrome's PDF viewer) can be lenient and silently decode `/Foo#20bar` as the string "Foo bar", which is why the earlier `addTextAnnotation()` sticky-note encoding had been shipping unnoticed since Round 1. **The bug was always there — Round 5a's StrikeOut just exposed it on the same code path.**

### Fix

Switch both `addStrikeOutAnnotation()` and `addTextAnnotation()` to encode `Contents` and `T` with the proper pdf-lib types:

```js
import { PDFDocument, PDFHexString, PDFString, rgb } from 'pdf-lib';

// …
Contents: PDFHexString.fromText(String(contents || '')),  // <FEFF…> UTF-16BE
T:        PDFString.of(String(author || '')),              // (Legal Overflow)
```

**API trap encountered**: `PDFHexString.of(text)` does NOT hex-encode the input — it wraps an already-hex-encoded string in `<…>`. The first attempt at the fix used `PDFHexString.of()` and produced corrupted content (`<Triple-restriction phrasing…>` — invalid hex chars get silently treated as zero by viewers). **`PDFHexString.fromText()` is the correct method** — it produces `<FEFF0054007200…>`, UTF-16BE with the byte-order-mark prefix the spec requires for Unicode text strings.

`PDFString.of()` was kept for `T` because:
- The author value is a known ASCII string ("Legal Overflow") with no parens to escape.
- Literal-string serialization is more readable when inspecting the raw PDF.
- `PDFString.of()` does NOT escape parens — using it on arbitrary text would break the parser if the text contained an unbalanced `(` or `)`. For `Contents` (which can contain anything), the hex form is the only safe choice.

### Verification (post-fix)

```
node tools/contract-grader/round-5a-runs/confirm-string-encoding.mjs

Checked 16 string fields across all annotations.
Passed (PDFString or PDFHexString): 16
Failed: 0
OK — every Contents/T field is a proper PDF text-string object.
```

Spot-check on the first StrikeOut annotation:

```
Contents class: PDFHexString
Contents raw: <FEFF0054007200690070006C0065002D0072006500730074007200690063…>
Has FEFF BOM: true
Contents decodeText(): "Triple-restriction phrasing is duplicative — only the non-exclusive…"
T class: PDFString
T raw: (Legal Overflow)
T decodeText(): "Legal Overflow"
```

The em-dash (`—`, U+2014) round-trips cleanly through UTF-16BE, confirming the encoding handles non-ASCII content correctly.

`tools/contract-grader/round-5a-runs/confirm-string-encoding.mjs` is committed as a permanent regression check. Run after any change to `markup-pdf.js` to catch a re-introduction of the Name-encoding bug.

### Acrobat re-verification — first pass

Acrobat opened the encoding-fixed PDF cleanly (no more "Expected a string object" popup). However, **the strikethrough rendered as an underline** — the line sat below the text, not through it. That's a separate geometry bug, fixed below.

## Acrobat-blocking fix #2 — QuadPoints geometry (PDF 1.7 §12.5.6.10)

### Diagnostic

`tools/contract-grader/round-5a-runs/probe-text-geometry.mjs` walks the test PDF, finds a known phrase, and prints what each part of the coordinate computation actually represents. Output for the 11pt body text on page 1:

```
item.transform: [11, 0, 0, 11, 72, 496]      ← font size = 11, baseline y = 496
item.width × height: 451.96 × 11
viewport tx[4,5] (top-down): 72, 296
yTop = pageHeight - tx[5] = 496              ← yTop EQUALS the text baseline (bottom-up)

Current (broken) quad:
  bottom edge (y)         = yTop - height = 485
  top    edge (y + height) = yTop          = 496
  → strike midpoint        = yTop - height/2 = 490.5  (5.5pt BELOW baseline — well below descender)

Correct quad:
  bottom edge (baseline)  = yTop          = 496
  top    edge (cap top)   = yTop + height = 507
  → strike midpoint        = yTop + height/2 = 501.5  (5.5pt ABOVE baseline — at x-height, where strikethroughs belong)
```

`yTop` is the **text baseline** in pdf-lib (bottom-up) coordinates. The previous code passed `y = yTop - height` to `addStrikeOutAnnotation()`, which made the helper build a quadrilateral spanning **from baseline DOWN by one font-height** — entirely below the text. Acrobat then drew the strike at the vertical center of that quad (about 5.5pt below baseline) — visually that landed at or just below the descender, which the user correctly called out as an "underline."

Vertex ordering (TL, TR, BL, BR per spec) was already correct — only the y-extents were wrong.

### Fix

One-line change in the call site:

```diff
  addStrikeOutAnnotation(pdfDoc, page, {
-   x, y: yTop - height, width, height,
+   x, y: yTop, width, height,
    contents: noteBody, author: AUTHOR,
  });
```

The helper itself is unchanged: it still treats the passed `y` as the bottom edge and `y + height` as the top edge. Now that `y = yTop = baseline`, the quad spans `[baseline, baseline + height]` and Acrobat renders the strike at the midpoint (`baseline + height/2`), which falls around the x-height for a typical Latin font — the natural strikethrough position.

### Verification

Programmatic re-inspection of the four StrikeOut annotations after the fix (full output in `synthetic-delete-marked.inspection.json`):

| Annotation | Rect [llx, lly, urx, ury] | Quad height | Strike midpoint vs baseline |
|---|---|---|---|
| 1 | [72.00, 585.60, 322.00, 596.60] | 11.00pt | midY = baseline + 5.50pt ✓ |
| 2 | [72.00, 274.80, 182.00, 285.80] | 11.00pt | midY = baseline + 5.50pt ✓ |
| 3 | [72.00, 610.80, 277.00, 621.80] | 11.00pt | midY = baseline + 5.50pt ✓ |
| 4 | [72.00, 549.20, 192.00, 560.20] | 11.00pt | midY = baseline + 5.50pt ✓ |

For each annotation: `BL.y < midY < TL.y` (i.e., strike line is inside the quad and above the baseline). All four quadrilaterals are 11pt tall (matching font size) and start at the baseline.

`confirm-string-encoding.mjs` still passes 16/16 — the encoding fix was unaffected by the geometry change.

### Awaiting Acrobat re-verification

The regenerated `synthetic-delete-marked.pdf` should now show the strike line through the middle of each target phrase, not below it. User to confirm in Acrobat:

- Strikethrough renders **through the text**, not below it.
- Strike covers the full horizontal extent of the source_text.
- Strike color is red (`/C [0.85 0.20 0.20]`).
- Comments panel still populates with the external_comment.
- Right-click → Accept/Reject markup options still present.

### Cross-viewer sanity (post-fix, optional)

PDF 1.7 §12.5.6.10's StrikeOut definition is unambiguous, so cross-viewer divergence is unexpected — but if it happens, Acrobat is the authoritative target. If Apple Preview or Chrome's PDF viewer shows the line in a different place, document the divergence; we will not chase it.

## Acrobat-blocking fix #3 — quad must encompass full text bbox (descender + ascender)

After fix #2 the strike still rendered LOW in Acrobat — the user reported it visually as an underline, not a strikethrough. Compared to Adobe's native Strikethrough tool on the same text, our line was clearly off.

### Diagnostic

Fix #2 made the quad span `[baseline, baseline + height]` — i.e. the quad started AT the baseline with no descender clearance below it. PDF 1.7 §12.5.6.10 says QuadPoints must "encompass the word or group of contiguous words" — meaning the quad has to bound the actual visual text, including the descender region (e.g. the bottom of letters like `g`, `p`, `y`).

Acrobat appears to interpret QuadPoints as the visual text bounding box and draws the strike near the *quad bottom* (or somewhere weighted-low within the quad), not at the geometric midpoint. With our baseline-anchored quad, that put the strike at or near the baseline — visually an underline.

A spec-faithful quad must include both:

- **Below the baseline** for descenders (≈ 0.20 × font size on most Latin fonts)
- **Above the baseline** for ascenders / cap height (≈ 0.80 × font size)

Doing this encompasses the full visual text region, and the strike then lands at the visually-correct mid-x-height position regardless of how the renderer interprets "midpoint."

### Fix

Refactor `addStrikeOutAnnotation()` to take explicit `yBottom`/`yTop` instead of `(y, height)`, so the call site computes the descender/ascender geometry directly:

```js
const DESCENDER_RATIO = 0.20;
const ASCENDER_RATIO  = 0.80;
const yBottomQuad = yTop - DESCENDER_RATIO * height;   // baseline − 0.20·size
const yTopQuad    = yTop + ASCENDER_RATIO  * height;   // baseline + 0.80·size

addStrikeOutAnnotation(pdfDoc, page, {
  x, width,
  yBottom: yBottomQuad,
  yTop:    yTopQuad,
  contents: noteBody,
  author: AUTHOR,
});
```

Quad midpoint is now at `baseline + 0.30 × font size` — that's between mid-x-height and cap-mid, the canonical strikethrough position regardless of how a viewer interprets QuadPoints.

### Programmatic verification

```
node tools/contract-grader/round-5a-runs/compare-quadpoints.mjs \
  tools/contract-grader/round-5a-runs/synthetic-delete-marked-v3.pdf

--- page 2, annotation #1 ---
Subtype: /StrikeOut
Rect [llx,lly,urx,ury]: [72.00, 583.40, 322.00, 594.40]
QuadPoints (8 numbers, 1 quadrilateral):
  Quad 1: TL(72.00, 594.40)  TR(322.00, 594.40)  BL(72.00, 583.40)  BR(322.00, 583.40)
           width=250.00, height=11.00, midY=588.90 (=BL.y + 5.50 = 50% from bottom)
```

For the page-2 baseline at y=585.60:
- Old (fix #2) quad: `[585.60, 596.60]`, midY at `baseline + 5.50pt`
- New (fix #3) quad: `[583.40, 594.40]`, midY at `baseline + 3.30pt` ← closer to canonical strike position
- Quad now spans the descender region (BL at 583.40 < baseline=585.60) and the ascender region (TL at 594.40 > baseline+x-height)

`confirm-string-encoding.mjs` still passes 16/16.

### Awaiting user comparison vs Adobe's native tool

The fix is geometric; matching Adobe to the pixel may require iterating against a real Adobe-marked reference. Procedure (see `tools/contract-grader/round-5a-runs/HOW-TO-PRODUCE-ADOBE-MANUAL-STRIKE.md`):

1. User opens any PDF that Acrobat handles cleanly, applies a manual Strikethrough using Adobe's native tool, saves as `adobe-manual-strike.pdf`.
2. We run `compare-quadpoints.mjs` on that PDF and on our generated `synthetic-delete-marked-v3.pdf`.
3. We adjust `DESCENDER_RATIO`/`ASCENDER_RATIO` (or the helper itself) until our QuadPoints geometry matches Adobe's for equivalent text runs.
4. Re-run, confirm visual parity.

The current ratios (0.20 / 0.80) are typical Latin-font metric estimates. Adobe likely uses font-metric-aware values queried from the embedded `FontDescriptor` — if our generic estimate is off for the specific font, the comparison step will tell us.

## Issue B — "Font Capture: Windows - Application Error" popup (root-caused; not blocking)

User saw a popup from Acrobat DC on Windows with `0xc06d007e` ("unknown software exception") immediately on opening the marked PDF.

### Diagnostic

`tools/contract-grader/round-5a-runs/probe-fonts.mjs` walks every page's `/Font` resource dict, dereferences each font, and reports:
- Font subtype (Type1, TrueType, CIDFontType0/2)
- BaseFont name
- Whether a `/FontDescriptor` is present
- Whether an embedded font stream (`/FontFile`, `/FontFile2`, `/FontFile3`) is present

Run on the source PDF (no annotations):

```
File: tools/contract-grader/test_contracts/msa_reasoning_test.pdf
Pages: 8
Unique font dicts referenced: 2

Font 4 0 R:
  /Type: /Font
  /Subtype: /Type1
  /BaseFont: /Times-Roman
  /Encoding: /WinAnsiEncoding
  → No FontDescriptor — font likely a Standard 14 (Helvetica/Times/Courier) and not embedded

Font 5 0 R:
  /Type: /Font
  /Subtype: /Type1
  /BaseFont: /Times-Bold
  /Encoding: /WinAnsiEncoding
  → No FontDescriptor — font likely a Standard 14 and not embedded
```

Then on the marked PDF:

```
File: tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf
Pages: 8
Unique font dicts referenced: 2
[exact same Font 4 0 R / Font 5 0 R, identical entries]
```

**The annotation pipeline does not touch fonts.** Font dictionaries are byte-identical between source and marked PDF.

### Root cause

The source PDF (`msa_reasoning_test.pdf`, generated by `tools/contract-grader/build_test_pdf.mjs`) uses **Type 1 Times-Roman / Times-Bold without embedded font streams** — the legacy "Standard 14 base font" pattern. Adobe Acrobat DC on Windows has been progressively deprecating its handling of unembedded Standard-14 fonts since around 2018. On modern builds (especially Acrobat DC 2024+ on Win 10/11) the substitution path can fail and the Font Capture subsystem throws `0xc06d007e`.

### Implications

- **Not an annotation pipeline bug.** Round 5a's tool changes are not a contributing factor.
- **Not blocking shipping.** Real-world contract PDFs (from Word's "Save as PDF", Google Docs, modern PDF generators) virtually always embed fonts. Production users will not see this popup.
- **Test fixture issue.** `tools/contract-grader/build_test_pdf.mjs` should be updated to embed fonts (e.g. by registering a TTF via `pdfDoc.embedFont(fontkit, ...)` or using a different generator). This is out of scope for Round 5a — it should be filed as a separate fixture-modernization task.

### User-side workaround during Acrobat verification

For Round 5a's visual verification, the user can either:
- Click past the Font Capture popup (Acrobat usually still renders the page after dismissing it), or
- Use a different test PDF that Acrobat handles cleanly. The QuadPoints comparison procedure (see "Awaiting user comparison" above) explicitly accepts ANY PDF — the geometry comparison just needs ground-truth Adobe output on text Acrobat can see clearly.

## Round 5b / 5c plan (carry-forward notes)

- **Round 5b — multi-line StrikeOut.** When the anchor text wraps across lines, `findTextHits()` currently returns one bounding box that may span multiple lines visually. The fix is: detect line breaks in the matched run (gap in y-coordinate between consecutive pdfjs items inside the match) and emit one quadrilateral per line, concatenated into a single `QuadPoints` array. Per spec, `QuadPoints` is a flat array of 8N numbers (N quadrilaterals). Single annotation, multi-line strikethrough.
- **Round 5b — multi-page.** When the anchor text spans a page break, emit two annotations (one per page) and link them via `/IRT` (in-reply-to) so they appear as a thread.
- **Round 5c — `replace` as paired StrikeOut + insertion.** `replace` should produce a real StrikeOut over the source_text *and* an "insertion" — either a `Caret` annotation at the end with the suggested_text in its popup, or a `FreeText` callout with the suggestion. We'll need to choose between these two on visual-quality grounds in 5c. Today's drawn-line behavior is preserved until then.
- ~~**Encoding cleanup.**~~ Done in Round 5a follow-up — see "Acrobat-blocking fix" above.

## Files changed

- `netlify/lib/markup-pdf.js` — split `delete`/`replace` branches; added `addStrikeOutAnnotation()` helper.
- `tools/contract-grader/round-5a-runs/synthetic-delete-findings.json` — new, 4 handcrafted delete findings.
- `tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf` — output for Acrobat visual review.
- `tools/contract-grader/round-5a-runs/synthetic-delete-marked.inspection.json` — programmatic inspection result.
- `tools/contract-grader/apply_markup.mjs` — restored from prior round (was deleted on this branch's main parent).
- `tools/contract-grader/inspect_pdf_markup.mjs` — same.
- `tools/contract-grader/round-5a-runs/confirm-string-encoding.mjs` — permanent regression check that every annotation's `Contents`/`T` field is a `PDFString` or `PDFHexString` (not `PDFName`).
- `tools/contract-grader/round-5a-runs/probe-text-geometry.mjs` — diagnostic that prints what `yTop` and `item.height` represent for a chosen text phrase in the test PDF. Used to identify the QuadPoints geometry bug; kept for future geometry investigations.
- `tools/contract-grader/round-5a-runs/compare-quadpoints.mjs` — dumps StrikeOut/Highlight/Underline QuadPoints from any PDF, with derived height/width/midpoint metrics. Used for ground-truth comparison vs Adobe's native Strikethrough tool.
- `tools/contract-grader/round-5a-runs/probe-fonts.mjs` — walks every page's font resource dict and reports embed/non-embed status. Used to root-cause the Acrobat Font Capture popup as a source-PDF issue, not an annotation pipeline issue.
- `tools/contract-grader/round-5a-runs/HOW-TO-PRODUCE-ADOBE-MANUAL-STRIKE.md` — instructions for the user to produce a ground-truth Adobe-marked PDF for QuadPoints comparison.
- `tools/contract-grader/round-5a-runs/synthetic-delete-marked-v3.pdf` — current geometry output (descender + ascender quad) for visual verification.
- `tools/contract-grader/REPORT_round_5a.md` — this file.

## Methodology note (for METHODOLOGY.md update)

When a markup_type is one specialists rarely emit (e.g., `delete` in current pipelines), use **handcrafted synthetic findings** to exercise the code path rather than running pipelines hoping the right type appears. Cost: $0 vs $0.50–$0.85 per pipeline run, and avoids non-deterministic test outcomes where the code path may not even fire.
