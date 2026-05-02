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
      // Round 5a — single-line StrikeOut annotation (proper PDF text-markup
      // annotation, not a drawn line). Acrobat / Foxit / Preview render
      // these natively with Accept/Reject UI; they're also discoverable as
      // /Subtype /StrikeOut by other PDF tooling.
      //
      // SCOPE (Round 5a follow-up #4 expansion):
      //   • Multi-line text supported — one quadrilateral per visual line
      //     per PDF 1.7 §12.5.6.10. The QuadPoints array length is 8×N
      //     where N is the line count from findTextLineRects.
      //   • Still single-page only. Cross-page matches deferred to Round 5b.
      //
      // For each line, build a quad spanning [baseline − 0.20·size,
      // baseline + 0.80·size] horizontally bounded by that line's actual
      // text extent (no `needle.length * 5` cap that overshot into the
      // right margin). Acrobat draws a separate strike mark per quad,
      // each properly bounded by its own line's text.
      //
      // Geometry rationale (Round 5a follow-up #3): the quad must
      // "encompass the word" per spec — descender below baseline, cap
      // height above. Acrobat positions the strike weighted toward the
      // visual middle of the quad, which lands at ~mid-x-height — the
      // canonical strikethrough position.
      const DESCENDER_RATIO = 0.20;
      const ASCENDER_RATIO  = 0.80;
      const lineQuads = lineRects.map((lr) => {
        const baseline = pageHeight - lr.y;
        return {
          x: lr.x,
          width: lr.width,
          yBottom: baseline - DESCENDER_RATIO * lr.height,
          yTop:    baseline + ASCENDER_RATIO  * lr.height,
        };
      });
      addStrikeOutAnnotation(pdfDoc, page, {
        lineQuads,
        contents: noteBody,
        author: AUTHOR,
      });
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
 * Round 5a follow-up #4 — find the per-visual-line rectangles covering
 * the matched text. Returns one entry per visual line on a single page,
 * each with an accurate width bounded by the items actually on that
 * line. Replaces the old `findTextHits` overshoot (which capped width
 * at `needle.length * 5` and could extend into the right margin).
 *
 * Algorithm:
 *   1. Build a per-page concatenation of item strings, joined by single
 *      spaces and lowercased. Track which char position came from which
 *      item so we can map matched ranges back to items.
 *   2. Find the (lowercased, whitespace-collapsed) needle's first
 *      occurrence in the concat using indexOf.
 *   3. Identify the items spanned by the matched range.
 *   4. Group those items by visual line (y-cluster within ½ font-height).
 *   5. For each line group, the rect is (min item x, max item x+width,
 *      shared y, shared height).
 *
 * Returns: Array<{ pageIndex, x, y, width, height }>, sorted top-down.
 * Empty array if no match.
 */
function findTextLineRects(positions, needle) {
  const byPage = {};
  for (const p of positions) {
    if (!p.str || !p.str.trim()) continue; // skip empty / whitespace-only items
    (byPage[p.pageIndex] ||= []).push(p);
  }
  const nNorm = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  if (nNorm.length < 4) return [];

  for (const [pageIdx, items] of Object.entries(byPage)) {
    // Build concat string + itemStarts[]. itemStarts[i] = index in concat
    // where items[i]'s chars begin. Each item is lowercased and has its
    // internal whitespace collapsed; items are joined by a single space.
    // The collapsed form is used for matching, but we keep the per-item
    // char count so we can map matched ranges back to in-item offsets.
    let concat = '';
    const itemStarts = [];
    const itemNormStrs = [];     // normalized string per item (for char counts)
    for (let i = 0; i < items.length; i++) {
      itemStarts.push(concat.length);
      const collapsed = items[i].str.toLowerCase().replace(/\s+/g, ' ');
      itemNormStrs.push(collapsed);
      concat += collapsed;
      if (i < items.length - 1) concat += ' ';
    }

    const idx = concat.indexOf(nNorm);
    if (idx === -1) continue;
    const matchEnd = idx + nNorm.length - 1;

    // For each item that overlaps the matched char range, compute the
    // sub-rectangle of that item's bbox that the match actually covers.
    // pdfjs often returns a whole visual line as ONE item — so when the
    // match starts/ends mid-item, we estimate the in-item x by linear
    // interpolation: x(c) = item.x + (c / itemNormLen) * item.width.
    // This is approximate (variable-width fonts mean per-char widths
    // differ), but is the only data we have without pulling glyph
    // metrics from pdfjs's lower-level APIs. Visual error is typically
    // a few characters on either side — orders of magnitude smaller
    // than the prior bug.
    const matchedSubRects = [];
    for (let i = 0; i < items.length; i++) {
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

      const xLeft  = items[i].x + (cStart / itemNormLen) * items[i].width;
      const xRight = items[i].x + (cEndExclusive / itemNormLen) * items[i].width;

      matchedSubRects.push({
        pageIndex: Number(pageIdx),
        x: xLeft,
        y: items[i].y,
        xEnd: xRight,
        height: items[i].height || 10,
      });
    }

    // Group sub-rects by visual line (y-cluster).
    const lines = [];
    let cur = null;
    for (const sr of matchedSubRects) {
      const lineTol = Math.max(2, (sr.height || 10) * 0.5);
      if (cur && Math.abs(sr.y - cur.y) <= lineTol) {
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
  return [];
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
 * Add a StrikeOut text-markup annotation over one or more text-run
 * rectangles. Multi-line text is expressed as N line-quads in a single
 * annotation per PDF 1.7 §12.5.6.10: the QuadPoints array is 8 × N
 * numbers, with each quadrilateral covering exactly one visual line's
 * matched text. Acrobat / Foxit / Preview render this as N separate
 * strike marks, properly bounded to each line.
 *
 * Round 5a follow-up #4 scope: multi-line single-page. Cross-page matches
 * still require splitting into multiple annotations (deferred to 5b).
 *
 * Each line-quad's yBottom/yTop should encompass the visual text on that
 * line — typically [baseline − descender, baseline + ascender]. Acrobat
 * draws the strike weighted toward the quad's vertical middle, so
 * descender clearance below the baseline is required (else the strike
 * sits at the baseline and reads as an underline).
 *
 * Vertex order in QuadPoints (per spec, also matches Acrobat's
 * preference): TL, TR, BL, BR.
 *
 * @param {PDFDocument} pdfDoc           — pdf-lib document
 * @param {PDFPage}     page              — page to annotate
 * @param {object}      box               — annotation metadata
 * @param {Array<{ x, width, yBottom, yTop }>} box.lineQuads
 *                                          one entry per visual line
 * @param {string}      box.contents      — popup comment text
 * @param {string}      box.author        — annotation author (T field)
 */
function addStrikeOutAnnotation(pdfDoc, page, { lineQuads, contents, author }) {
  if (!Array.isArray(lineQuads) || lineQuads.length === 0) return;
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

  const annotDict = ctx.obj({
    Type: 'Annot',
    Subtype: 'StrikeOut',
    Rect: rect,
    QuadPoints: quadPoints,
    C: [0.85, 0.2, 0.2],
    Contents: PDFHexString.fromText(String(contents || '')),
    T: PDFString.of(String(author || '')),
    F: 4,                          // Print flag
    CA: 0.85,                      // Constant opacity
  });
  const annotRef = ctx.register(annotDict);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(ctx.obj('Annots'), ctx.obj([annotRef]));
  }
}
