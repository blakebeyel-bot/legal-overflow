# Round 5b — PDF strikethrough multi-page support (IRT linking)

**Branch:** `round-5b-pdf-multipage-strikethrough` (off main, post-5a-merge `98ee56a`)
**Date:** 2026-05-02
**Cost:** $0 — no pipeline run needed; synthetic findings sufficient.
**Status:** Programmatic verification passes (17/17 on multi-page test; 16/16 on Round-5a regression test). Awaiting user-side Adobe Acrobat visual confirmation.

## Goal recap

Round 5a (and follow-ups) shipped single-page strikethroughs — single-line and multi-line. Round 5b extends that to text spanning page boundaries.

PDF 1.7 §12.5.6.10 (markup annotations) doesn't allow a single annotation's QuadPoints to cross pages — every quadrilateral is in the page's user-space coordinate system. To express a logical edit that spans pages, the convention is:

- Write **N annotations** (one per page that has matched text).
- Link them via the **`/IRT` (In Reply To)** entry: each subsequent annotation's `/IRT` references the FIRST annotation's PDFRef.
- Only the FIRST annotation carries `/Contents` and `/T` (author). Subsequent annotations defer to the leader via IRT — Acrobat's Comments panel pulls Contents from the IRT-target.

Acrobat treats the IRT-linked group as one logical edit: clicking any annotation in the group highlights the others, and Accept/Reject acts on all together.

## Implementation (`netlify/lib/markup-pdf.js`)

### `findTextLineRects` — global concat across pages

Replaced the per-page `for...continue` loop with a single global concatenation across all pages, sorted in reading order `(pageIndex asc, y asc, x asc)`. Each item retains its `pageIndex` so we can group results by page after the match.

```js
const allItems = [/* flat list, all pages */];
allItems.sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x);
let concat = '';
for (const it of allItems) { concat += it.str.toLowerCase(); concat += ' '; }
const idx = concat.indexOf(nNorm);
```

The `idx` lookup now succeeds for cross-page matches because the concat string spans page boundaries. Per-item sub-rect computation (with linear-interpolation in-item offset estimation, from Round 5a fix #4) is unchanged. The line-grouping pass adds a `samePage` check — sub-rects on different pages NEVER cluster into the same line, even if their y-values happen to coincide.

Returned shape is unchanged: `Array<{ pageIndex, x, y, width, height }>`. Multi-page matches return entries with different `pageIndex` values; the rest of the pipeline groups by page.

### `addStrikeOutAnnotation` — optional IRT, returns PDFRef

Refactored to support its new role as a per-page primitive in a multi-page group:

```js
function addStrikeOutAnnotation(pdfDoc, page, { lineQuads, contents, author, irt }) {
  // ... build QuadPoints ...
  const dictFields = {
    Type: 'Annot', Subtype: 'StrikeOut', Rect, QuadPoints,
    C: [...], F: 4, CA: 0.85,
  };
  if (contents != null) dictFields.Contents = PDFHexString.fromText(contents);
  if (author != null)   dictFields.T = PDFString.of(author);
  if (irt)              dictFields.IRT = irt;          // NEW
  const annotRef = ctx.register(ctx.obj(dictFields));
  // ... push to page Annots ...
  return annotRef;                                      // NEW
}
```

Three changes vs Round 5a:
1. **`irt` parameter** (optional) — when set, adds an `/IRT` entry pointing to a previously-written annotation's PDFRef.
2. **Contents/T are optional** — if `null`/`undefined`, omitted from the dict. Per Adobe convention, IRT-linked followers omit these.
3. **Returns `PDFRef`** — so the caller can pass it as `irt` for subsequent annotations in the same group.

### New `addStrikeOutGroup` orchestrator

Wraps the per-page calls and threads IRT references:

```js
function addStrikeOutGroup(pdfDoc, groups, contents, author) {
  let firstRef = null;
  for (const g of groups) {
    const page = pdfDoc.getPage(g.pageIndex);
    const ref = addStrikeOutAnnotation(pdfDoc, page, {
      lineQuads: g.lineQuads,
      contents: firstRef ? null : contents,   // only on leader
      author:   firstRef ? null : author,     // only on leader
      irt:      firstRef ? firstRef : null,   // followers point to leader
    });
    if (!firstRef && ref) firstRef = ref;
  }
}
```

### Call site

The delete-finding path now groups `lineRects` by page and invokes `addStrikeOutGroup`:

```js
const byPageMap = new Map();
for (const lr of lineRects) {
  if (!byPageMap.has(lr.pageIndex)) byPageMap.set(lr.pageIndex, []);
  byPageMap.get(lr.pageIndex).push(lr);
}
const groups = [];
for (const [pIdx, prRects] of [...byPageMap.entries()].sort((a, b) => a[0] - b[0])) {
  const pg = pdfDoc.getPage(pIdx);
  const ph = pg.getHeight();
  const quads = prRects.map((lr) => {
    const baseline = ph - lr.y;
    return {
      x: lr.x, width: lr.width,
      yBottom: baseline - 0.20 * lr.height,
      yTop:    baseline + 0.80 * lr.height,
    };
  });
  groups.push({ pageIndex: pIdx, lineQuads: quads });
}
addStrikeOutGroup(pdfDoc, groups, noteBody, AUTHOR);
```

For single-page matches, `groups.length === 1` and only the leader is written — no IRT, identical to Round 5a's output. For multi-page, `groups.length === N` and N-1 IRT-linked followers are written after the leader.

## Test scenario

`tools/contract-grader/round-5b-runs/synthetic-pagebreak-findings.json` — 3 findings:

1. **Multi-page case.** `source_text` = `"Fees do not include any taxes, levies, duties, or similar governmental assessments"`. This phrase ends page 2 with `taxes, levies,` and continues page 3 with `duties, or similar governmental assessments` — clean page-break crossing.

2. **Single-line regression.** `"in its sole discretion"` (Round 5a baseline). Should produce one annotation, no IRT.

3. **Multi-line single-page regression.** `"Lattice's sole obligations and Customer's sole and exclusive remedies for failures to meet such service-level commitments are the service credits described in Exhibit A."` (Round 5a fix #4 case, 3 visual lines on page 2). Should produce one annotation with 3 quads, no IRT.

## Programmatic verification — `verify-pagebreak.mjs`

```
=== Round 5b verification ===

Total /StrikeOut annotations in PDF: 4

  page 2, ref=22 0 R, 1 quad,  has Contents, has T, IRT=none
    Contents: "Tax-exclusion language is overly broad..."
  page 2, ref=25 0 R, 1 quad,  has Contents, has T, IRT=none
    Contents: "Vendor-favorable absolute-discretion language..."
  page 2, ref=27 0 R, 3 quads, has Contents, has T, IRT=none
    Contents: "Service credits as the SOLE remedy is too restrictive..."
  page 3, ref=23 0 R, 1 quad,  NO Contents, NO T, IRT=22 0 R

=== Logical edit groups: 3 ===

Group 1: 2 annotations on pages 2, 3   ← multi-page
  Leader (page 2, ref=22 0 R): Tax-exclusion language…
  Follower (page 3, ref=23 0 R, IRT=22 0 R): no Contents (correct)

Group 2: 1 annotation on page 2          ← single-line
Group 3: 1 annotation on page 2          ← multi-line single-page

Passed: 17
Failed: 0
ALL CHECKS PASSED — Round 5b structure is correct.
```

The verifier checks:
- Total `/StrikeOut` count.
- For each logical edit group: leader has `Contents` + `T` + no `IRT`; followers have `IRT` pointing to the leader's ref AND no `Contents`/`T` of their own; followers are on a different page from the leader.
- Every annotation has ≥1 valid quadrilateral.

### Geometry of the multi-page case

| Page | Quads | x range | width | y baseline (pdf-lib) |
|---|---|---|---|---|
| 2 (leader) | 1 | 366.5 → 533.6 | 167.1pt | bottom of page (last line) |
| 3 (follower) | 1 | 72.0 → 259.9 | 187.9pt | top of page (first line) |

Page 2's strike is on the END of the last line (where the matched text starts mid-line). Page 3's strike is on the START of the first line (where the matched text ends mid-line). Both bounded tightly to actual text — no overshoot.

## Regression check — Round 5a multi-line test

Re-ran `synthetic-multiline-findings.json` (the Round 5a fix #4 test, 4 findings exercising 3-line, 2-line, and 1-line cases) through the Round 5b code:

```
verify-pagebreak.mjs regression-5a-multiline-marked.pdf
=== Logical edit groups: 4 ===
Passed: 16
Failed: 0
ALL CHECKS PASSED — Round 5b structure is correct.
```

All four 5a findings still produce a single annotation each (no spurious IRT). 5b is regression-clean.

## Adobe IRT-structure inspection note

The user's spec asked for confirmation of Adobe's native multi-page Strikethrough output structure. The sandbox doesn't have Acrobat for the agent to operate, so I implemented to spec (PDF 1.7 §12.5.6.10 + the documented Adobe convention of leader-carries-Contents / followers-carry-IRT). The `verify-pagebreak.mjs` invariants encode the structure I expect Adobe to produce; if the user later inspects an Adobe-marked PDF and finds a different convention, the helper's three optional fields (`contents`, `author`, `irt`) make it trivial to flip.

## Pass conditions (from spec)

| Condition | Status |
|---|---|
| Multi-page strikes produce two visible strike annotations, one per page | ✅ verified programmatically (1 per page across the 2-page span) |
| `/IRT` relationship correctly written (follower → leader) | ✅ follower's IRT field equals leader's PDFRef (22 0 R) |
| Adobe Acrobat treats them as one logical edit in Comments panel | ⏳ user task |
| No regression on Round 5a single-page cases | ✅ both regression-checks pass |

## Awaiting user verification

Open `tools/contract-grader/round-5b-runs/synthetic-pagebreak-marked.pdf` in Acrobat and confirm:

- Page 2's last line shows a strike from the end of "taxes, levies," to the line wrap.
- Page 3's first line shows a strike from the start of "duties, or similar governmental..." up to "...assessments".
- The Comments panel shows ONE entry for the tax-exclusion edit (not two), with the Contents text visible.
- Clicking either strike highlights/selects the other.
- Right-click → Accept / Reject acts on both at once.
- The other two findings (single-line "in its sole discretion" and the 3-line service-credits phrase) still render correctly with no IRT artifacts.

Cross-check in Apple Preview: different viewers handle IRT differently — Preview may show the two annotations as separate Comment items, which is acceptable per the spec ("Adobe Acrobat's behavior is the authoritative target").

## Files changed

- **`netlify/lib/markup-pdf.js`** — `findTextLineRects` extended for cross-page matching; `addStrikeOutAnnotation` refactored with optional `irt` + returns `PDFRef`; new `addStrikeOutGroup` orchestrator; call site updated to group by page.
- **`tools/contract-grader/round-5b-runs/synthetic-pagebreak-findings.json`** — 3 handcrafted findings (1 multi-page + 2 regression).
- **`tools/contract-grader/round-5b-runs/synthetic-pagebreak-marked.pdf`** — output for visual review.
- **`tools/contract-grader/round-5b-runs/verify-pagebreak.mjs`** — permanent regression verifier.
- **`tools/contract-grader/round-5b-runs/regression-5a-multiline-marked.pdf`** — 5a regression output.
- **`tools/contract-grader/REPORT_round_5b.md`** — this file.

## Carry-forward

- Per-finding cap: when a single source_text spans 3+ pages (e.g. an extremely long quoted block), `addStrikeOutGroup` writes N IRT-linked annotations correctly. The verifier covers this case structurally; no upper bound enforced. Real-world contract clauses rarely span more than 2 pages, so this is overhead capacity rather than a tested case.
- Cross-document matches (text appearing in two non-adjacent occurrences) are not supported — `findTextLineRects` returns the FIRST occurrence only.
- 5b is StrikeOut-specific; the parallel `replace` and `insert` markup paths still use legacy `page.drawLine` on this branch (those are 5c's concern; the 5c branch has already redesigned them).
