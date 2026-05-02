/**
 * PDF markup — JS port of scripts/markup_pdf.py.
 *
 * Uses pdfjs-dist to extract text-with-positions (so we can find where an
 * anchor string lives on the page) and pdf-lib to stamp annotations:
 *   - strikethrough highlight over source_text (for 'replace' and 'delete')
 *   - caret marker at anchor location (for 'insert')
 *   - sticky-note popup containing the external_comment
 *
 * Per CLAUDE.md §4.5 for PDFs: proposed replacement language lives INSIDE
 * the sticky-note comment body, prefixed with "PROPOSED REPLACEMENT
 * LANGUAGE: ...". We do NOT stamp FreeText insertion boxes on the page
 * face — that clutters the document.
 *
 * Per CLAUDE.md §4.7: the extract step already refuses scanned PDFs with
 * <200 chars of text. By the time findings arrive here, the PDF is known
 * to be native/text-bearing.
 */
import { PDFDocument, PDFHexString, PDFString, rgb } from 'pdf-lib';
// pdfjs-dist is lazy-loaded inside extractTextPositions() to keep it off
// the cold-start path. The DOCX markup path never needs it, and a broken
// PDF dep must not crash the whole function.

const AUTHOR = 'Legal Overflow';

/**
 * Apply findings to a PDF buffer. Returns a new PDF buffer with annotations.
 *
 * @param {Buffer} pdfBuffer
 * @param {Array<Finding>} findings
 * @returns {Promise<{ buffer: Buffer, applied: number, unanchored: Finding[] }>}
 */
export async function applyPdfMarkup(pdfBuffer, findings) {
  // Step 1: extract text with positions using pdfjs-dist
  const positions = await extractTextPositions(pdfBuffer);

  // Step 2: load the PDF for editing with pdf-lib
  const pdfDoc = await PDFDocument.load(pdfBuffer);

  const applied = [];
  const unanchored = [];

  for (const f of findings) {
    const { markup_type, source_text, anchor_text, external_comment, suggested_text } = f;
    const searchText = source_text || anchor_text || '';
    if (!searchText || searchText.length < 8) {
      unanchored.push(f);
      continue;
    }

    // Round 5a follow-up #4 — multi-line support. findTextLineRects
    // returns one rect per VISUAL line the matched text occupies, with an
    // accurate width per line (no more `needle.length * 5` cap that
    // overshot into the right margin). Single-line matches return a
    // single-element array — same shape, same code path.
    const lineRects = findTextLineRects(positions, searchText);
    if (lineRects.length === 0) {
      unanchored.push(f);
      continue;
    }

    const page = pdfDoc.getPage(lineRects[0].pageIndex);
    const pageHeight = page.getHeight();

    // First line's coordinates drive the sticky-note placement and the
    // legacy single-line replace/insert paths. Multi-line matches
    // additionally pass all line rects to the StrikeOut helper below.
    const firstLine = lineRects[0];
    const x = firstLine.x;
    const yTop = pageHeight - firstLine.y;   // baseline in pdf-lib coords
    const width = firstLine.width;
    const height = firstLine.height;

    // Build the sticky-note body per CLAUDE.md §4.5
    let noteBody = external_comment || '';
    if (markup_type === 'replace' && suggested_text) {
      noteBody = `${noteBody}\n\nPROPOSED REPLACEMENT LANGUAGE:\n${suggested_text}`.trim();
    } else if (markup_type === 'insert' && suggested_text) {
      noteBody = `${noteBody}\n\nPROPOSED INSERTION:\n${suggested_text}`.trim();
    } else if (markup_type === 'delete') {
      noteBody = `${noteBody}\n\n[PROPOSED DELETION — remove the struck-through text.]`.trim();
    }

    if (markup_type === 'delete') {
      // Round 5a/5b — proper PDF /Subtype /StrikeOut annotation(s).
      //
      // Single-page (one or many lines) → one annotation with N
      //   quadrilaterals per PDF 1.7 §12.5.6.10.
      // Multi-page (text spans page break) → one annotation per page,
      //   linked via /IRT so Acrobat treats the group as a single
      //   logical edit. Adobe's native multi-page Strikethrough tool
      //   produces this same structure.
      //
      // Geometry per line: quad spans [baseline − 0.20·size,
      //   baseline + 0.80·size] horizontally bounded by that line's
      //   actual text extent. Strike midpoint lands at mid-x-height.
      const DESCENDER_RATIO = 0.20;
      const ASCENDER_RATIO  = 0.80;

      // Group line-rects by page (Round 5b). Each group becomes its
      // own annotation; addStrikeOutGroup threads /IRT references.
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
            x: lr.x,
            width: lr.width,
            yBottom: baseline - DESCENDER_RATIO * lr.height,
            yTop:    baseline + ASCENDER_RATIO  * lr.height,
          };
        });
        groups.push({ pageIndex: pIdx, lineQuads: quads });
      }
      addStrikeOutGroup(pdfDoc, groups, noteBody, AUTHOR);
    } else if (markup_type === 'replace') {
      // Existing behavior — drawn red line (visual strikethrough). Real
      // StrikeOut annotation for replace findings is deferred to Round 5c
      // because replace also needs a paired insertion annotation.
      page.drawLine({
        start: { x, y: yTop - height / 2 },
        end: { x: x + width, y: yTop - height / 2 },
        thickness: 1,
        color: rgb(0.85, 0.2, 0.2),
        opacity: 0.85,
      });
    } else if (markup_type === 'insert') {
      // Caret ^ at insertion point
      page.drawLine({
        start: { x: x + width, y: yTop - height + 1 },
        end: { x: x + width + 4, y: yTop - height / 2 + 2 },
        thickness: 1,
        color: rgb(0.04, 0.49, 0.34),
      });
      page.drawLine({
        start: { x: x + width + 4, y: yTop - height / 2 + 2 },
        end: { x: x + width + 8, y: yTop - height + 1 },
        thickness: 1,
        color: rgb(0.04, 0.49, 0.34),
      });
    }

    // Sticky note (Text annotation) — pdf-lib doesn't have a first-class
    // API for this, so we add via low-level dict manipulation.
    addTextAnnotation(pdfDoc, page, {
      x: x + width + 10,
      y: yTop - height,
      contents: noteBody,
      author: AUTHOR,
    });

    applied.push(f);
  }

  const outBytes = await pdfDoc.save();
  return { buffer: Buffer.from(outBytes), applied: applied.length, unanchored };
}

// ---------- pdfjs text-position extraction ----------

async function extractTextPositions(pdfBuffer) {
  // Lazy-load pdfjs-dist — only callers of applyPdfMarkup (i.e. PDF
  // contract reviews) pay the import cost.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8 = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8, disableFontFace: true });
  const pdf = await loadingTask.promise;
  const positions = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    for (const item of textContent.items) {
      if (!item.str) continue;
      // item.transform is [a,b,c,d,e,f] — e,f are x,y in pdf-space
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4];
      const y = tx[5];
      positions.push({
        pageIndex: i - 1,
        str: item.str,
        x,
        y,
        width: item.width,
        height: item.height || 10,
      });
    }
  }
  return positions;
}

/**
 * Round 5a follow-up #4 + Round 5b — find the per-visual-line
 * rectangles covering the matched text. Returns one entry per visual
 * line, each with an accurate width bounded by the items actually on
 * that line. Multi-line single-page support from 5a fix #4; multi-page
 * support added in Round 5b — `pageIndex` may differ across returned
 * entries when the matched text spans a page break.
 *
 * Algorithm:
 *   1. Build a GLOBAL concatenation across all pages, joined by single
 *      spaces and lowercased. Each item retains its pageIndex so we
 *      can group results by page later. Items are sorted in reading
 *      order: (pageIndex asc, y asc — pdfjs y is top-down — then x asc).
 *   2. Find the (lowercased, whitespace-collapsed) needle's first
 *      occurrence in the global concat using indexOf. Cross-page
 *      matches succeed because the concat string spans page boundaries.
 *   3. For each item that overlaps the matched char range, compute a
 *      sub-rectangle. When the match starts/ends mid-item, estimate
 *      the in-item x by linear interpolation:
 *        x(c) = item.x + (c / itemNormLen) × item.width
 *      pdfjs returns whole visual lines as single items, so this
 *      mid-item estimation is required for accurate first-line and
 *      last-line bounds.
 *   4. Group sub-rects by (pageIndex, y-cluster within ½ font-height).
 *      Sub-rects on different pages NEVER cluster together, even if
 *      their y values happen to coincide.
 *   5. Return per-line rects, ordered (page asc, y asc).
 *
 * Returns: Array<{ pageIndex, x, y, width, height }>. May contain
 * entries with different pageIndex values for multi-page matches.
 */
function findTextLineRects(positions, needle) {
  // Flatten + sort all items in document reading order (page asc → y asc → x asc).
  // pdfjs y is top-down, so y asc = top-of-page first.
  const allItems = [];
  for (const p of positions) {
    if (!p.str || !p.str.trim()) continue;
    allItems.push(p);
  }
  allItems.sort((a, b) =>
    a.pageIndex - b.pageIndex
    || a.y - b.y
    || a.x - b.x,
  );

  // Build one global concat across all pages.
  let concat = '';
  const itemStarts = [];
  const itemNormStrs = [];
  for (let i = 0; i < allItems.length; i++) {
    itemStarts.push(concat.length);
    const collapsed = allItems[i].str.toLowerCase().replace(/\s+/g, ' ');
    itemNormStrs.push(collapsed);
    concat += collapsed;
    if (i < allItems.length - 1) concat += ' ';
  }

  const nNorm = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  if (nNorm.length < 4) return [];
  const idx = concat.indexOf(nNorm);
  if (idx === -1) return [];
  const matchEnd = idx + nNorm.length - 1;

  // Compute per-item sub-rects.
  const matchedSubRects = [];
  for (let i = 0; i < allItems.length; i++) {
    const itemStart = itemStarts[i];
    const itemNormLen = itemNormStrs[i].length;
    if (itemNormLen === 0) continue;
    const itemEnd = itemStart + itemNormLen - 1;
    if (itemEnd < idx || itemStart > matchEnd) continue;

    const isFirst = idx >= itemStart && idx <= itemEnd;
    const isLast = matchEnd >= itemStart && matchEnd <= itemEnd;
    const cStart = isFirst ? idx - itemStart : 0;
    const cEndInclusive = isLast ? matchEnd - itemStart : itemNormLen - 1;
    const cEndExclusive = Math.min(cEndInclusive + 1, itemNormLen);

    const xLeft  = allItems[i].x + (cStart / itemNormLen) * allItems[i].width;
    const xRight = allItems[i].x + (cEndExclusive / itemNormLen) * allItems[i].width;

    matchedSubRects.push({
      pageIndex: allItems[i].pageIndex,
      x: xLeft,
      y: allItems[i].y,
      xEnd: xRight,
      height: allItems[i].height || 10,
    });
  }

  // Group sub-rects by (pageIndex, y-line). Sub-rects on different pages
  // never merge — Round 5b's whole point. The sort above keeps the
  // grouping linear: when pageIndex changes, force a new group.
  const lines = [];
  let cur = null;
  for (const sr of matchedSubRects) {
    const lineTol = Math.max(2, (sr.height || 10) * 0.5);
    const samePage = cur && cur.pageIndex === sr.pageIndex;
    const sameLine = samePage && Math.abs(sr.y - cur.y) <= lineTol;
    if (sameLine) {
      cur.x = Math.min(cur.x, sr.x);
      cur.xEnd = Math.max(cur.xEnd, sr.xEnd);
      cur.height = Math.max(cur.height, sr.height);
    } else {
      if (cur) lines.push(cur);
      cur = {
        pageIndex: sr.pageIndex,
        x: sr.x,
        y: sr.y,
        xEnd: sr.xEnd,
        height: sr.height,
      };
    }
  }
  if (cur) lines.push(cur);

  return lines.map((l) => ({
    pageIndex: l.pageIndex,
    x: l.x,
    y: l.y,
    width: Math.max(8, l.xEnd - l.x),
    height: l.height,
  }));
}

/**
 * Legacy wrapper. Returns the bounding box of just the FIRST line of a
 * matched text. Used by paths that don't (yet) consume per-line rects —
 * specifically the drawn-line replace and caret insert legacy paths.
 * Multi-line StrikeOut writes via findTextLineRects directly.
 */
function findTextHits(positions, needle) {
  const lines = findTextLineRects(positions, needle);
  return lines.length > 0 ? [lines[0]] : [];
}

// ---------- sticky-note annotation (low-level) ----------

function addTextAnnotation(pdfDoc, page, { x, y, contents, author }) {
  const ctx = pdfDoc.context;
  // Round 5a fix — PDF 1.7 §7.9.2/§12.5.6.4 require Contents and T to be
  // text *string* objects, not Name objects. pdf-lib's `ctx.obj(string)`
  // emits a Name (because Name is the dominant string-shaped type in PDF
  // dicts: /Type /Annot etc.), which Acrobat rejects with
  // "Expected a string object." Encode explicitly:
  //   • Contents → PDFHexString.fromText() — encodes as UTF-16BE hex
  //     with BOM (FEFF...), spec-compliant per §7.9.2.2 and robust
  //     against apostrophes, parens, non-ASCII, etc. NOTE: PDFHexString.of()
  //     does NOT encode — it just wraps an already-hex string in <>; using
  //     it on raw text produces corrupted content.
  //   • T → PDFString.of() — literal string in parens; fine for an
  //     ASCII author name like "Legal Overflow" with no parens to escape.
  const annotDict = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x, y - 20, x + 20, y],
    Contents: PDFHexString.fromText(String(contents || '')),
    T: PDFString.of(String(author || '')),
    Name: 'Comment',
    Open: false,
  });
  const annotRef = ctx.register(annotDict);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(ctx.obj('Annots'), ctx.obj([annotRef]));
  }
}

// ---------- Round 5a: StrikeOut annotation (proper PDF markup) ----------

/**
 * Add a single StrikeOut text-markup annotation to one page. Multi-line
 * text on the same page is expressed as N line-quads in one annotation
 * per PDF 1.7 §12.5.6.10: QuadPoints array of 8 × N numbers, one
 * quadrilateral per visual line.
 *
 * Round 5b — multi-page support is handled at a higher level by
 * `addStrikeOutGroup()`, which calls this helper once per page and
 * threads IRT references between calls. To support that orchestration,
 * this helper:
 *   • Takes optional `irt` (a PDFRef of a previously-written annotation
 *     in the same logical group). When set, an `/IRT` entry is added.
 *   • Returns the PDFRef of the annotation it just wrote, so the caller
 *     can pass it as `irt` for subsequent annotations.
 *   • Includes Contents/T only when supplied. Per Adobe's native
 *     multi-page Strikethrough convention, the FIRST annotation in a
 *     group carries Contents/T; subsequent annotations defer to it via
 *     IRT. Acrobat then displays the group as one logical edit.
 *
 * Vertex order in QuadPoints (per spec): TL, TR, BL, BR.
 *
 * @param {PDFDocument} pdfDoc          — pdf-lib document
 * @param {PDFPage}     page             — page to annotate
 * @param {object}      box              — annotation metadata
 * @param {Array<{ x, width, yBottom, yTop }>} box.lineQuads
 *                                         one entry per visual line on this page
 * @param {string}      [box.contents]   — popup comment text (omit on IRT-linked annotations)
 * @param {string}      [box.author]     — annotation author (T field; omit on IRT-linked)
 * @param {PDFRef}      [box.irt]        — IRT reference to prior annotation in the same group
 * @returns {PDFRef} reference to the annotation just written
 */
function addStrikeOutAnnotation(pdfDoc, page, { lineQuads, contents, author, irt }) {
  if (!Array.isArray(lineQuads) || lineQuads.length === 0) return null;
  const ctx = pdfDoc.context;

  // Build QuadPoints: 8 numbers per line in TL/TR/BL/BR order.
  const quadPoints = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const lq of lineQuads) {
    const xL = lq.x;
    const xR = lq.x + lq.width;
    quadPoints.push(
      xL, lq.yTop,        // TL
      xR, lq.yTop,        // TR
      xL, lq.yBottom,     // BL
      xR, lq.yBottom,     // BR
    );
    minX = Math.min(minX, xL);
    maxX = Math.max(maxX, xR);
    minY = Math.min(minY, lq.yBottom);
    maxY = Math.max(maxY, lq.yTop);
  }

  // Rect is the bounding box of all line-quads combined. Per spec it's
  // informational; QuadPoints determines the visible strike marks.
  const rect = [minX, minY, maxX, maxY];

  // Build dict piecewise so optional fields (Contents, T, IRT) can be
  // included or omitted based on the helper's role in the IRT group.
  const dictFields = {
    Type: 'Annot',
    Subtype: 'StrikeOut',
    Rect: rect,
    QuadPoints: quadPoints,
    C: [0.85, 0.2, 0.2],
    F: 4,                          // Print flag
    CA: 0.85,                      // Constant opacity
  };
  if (contents != null) dictFields.Contents = PDFHexString.fromText(String(contents));
  if (author != null) dictFields.T = PDFString.of(String(author));
  if (irt) dictFields.IRT = irt;

  const annotDict = ctx.obj(dictFields);
  const annotRef = ctx.register(annotDict);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(ctx.obj('Annots'), ctx.obj([annotRef]));
  }
  return annotRef;
}

// ---------- Round 5b: multi-page StrikeOut group orchestrator ----------

/**
 * Write one logical StrikeOut "edit" that may span multiple pages.
 * Single-page matches produce one annotation. Multi-page matches
 * produce N annotations (one per page) linked via PDF /IRT (In Reply
 * To) per PDF 1.7 §12.5.6.10.
 *
 * Adobe convention (verified by inspecting Adobe Acrobat's native
 * multi-page Strikethrough output and replicated here):
 *   • First annotation in the group carries Contents and T (author).
 *   • Subsequent annotations have /IRT pointing back to the first.
 *     They omit Contents/T — Acrobat's Comments panel pulls those
 *     from the IRT-target annotation.
 *   • Acrobat treats the group as one logical edit: clicking either
 *     highlights the others, and Accept/Reject acts on all together.
 *
 * @param {PDFDocument} pdfDoc
 * @param {Array<{ pageIndex, lineQuads }>} groups — one entry per
 *   page that has lines to strike, sorted by reading order.
 * @param {string} contents — popup comment for the first annotation
 * @param {string} author   — author T for the first annotation
 */
function addStrikeOutGroup(pdfDoc, groups, contents, author) {
  if (!Array.isArray(groups) || groups.length === 0) return;
  let firstRef = null;
  for (const g of groups) {
    const page = pdfDoc.getPage(g.pageIndex);
    const ref = addStrikeOutAnnotation(pdfDoc, page, {
      lineQuads: g.lineQuads,
      contents: firstRef ? null : contents,
      author:   firstRef ? null : author,
      irt:      firstRef ? firstRef : null,
    });
    if (!firstRef && ref) firstRef = ref;
  }
}
