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

    const hits = findTextHits(positions, searchText);
    if (hits.length === 0) {
      unanchored.push(f);
      continue;
    }
    const hit = hits[0]; // use first occurrence

    const page = pdfDoc.getPage(hit.pageIndex);
    const pageHeight = page.getHeight();

    // pdfjs origin is top-left; pdf-lib origin is bottom-left. Flip Y.
    const x = hit.x;
    const yTop = pageHeight - hit.y;
    const width = hit.width;
    const height = hit.height;

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
      // SCOPE LIMITS (per Round 5a spec):
      //   • Single-line text only. Wrapped text would need multiple
      //     QuadPoint rectangles (see Round 5b).
      //   • Single-page text only.
      //   • Drawn-line fallback is REMOVED for delete findings — replaced
      //     by the proper annotation. Other markup types keep their
      //     existing drawn-line behavior unchanged.
      //
      // The hit's (x, yTop, width, height) are the text run's bounding box
      // in pdf-lib coordinates (y from bottom). A single quadrilateral is
      // sufficient for single-line text. If the hit's width spans multiple
      // lines (text wrapped), the annotation will span only the first
      // line — the multi-line case is deferred to Round 5b.
      // Round 5a follow-up #2 — geometry fix.
      //
      // pdfjs's Util.transform(viewport.transform, item.transform)[5]
      // gives a top-down y in the page-flipped coordinate system. Our
      // call site flips it back with `yTop = pageHeight - tx[5]`, which
      // makes `yTop` equal the **text baseline** in pdf-lib (bottom-up)
      // coordinates — verified empirically with
      // round-5a-runs/probe-text-geometry.mjs.
      //
      // The previous code passed `y = yTop - height` to this helper, then
      // built the quad from y..y+height. That made the quad span the
      // region BELOW the baseline (baseline-height .. baseline) and the
      // strike midpoint landed roughly mid-descender — Acrobat rendered
      // it as an underline.
      //
      // The correct quad spans baseline → baseline+height (i.e. up
      // through the glyph cap). Acrobat draws StrikeOut at the vertical
      // center of the quad, which then falls around the x-height, where
      // a strikethrough visually belongs. So we pass y = yTop directly.
      addStrikeOutAnnotation(pdfDoc, page, {
        x, y: yTop, width, height,
        contents: noteBody, author: AUTHOR,
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
 * Greedy text search across position items. Concatenates consecutive items
 * on the same page into a flat string and finds the needle — returns the
 * first item's position + summed width as a bounding box.
 */
function findTextHits(positions, needle) {
  const byPage = {};
  for (const p of positions) {
    (byPage[p.pageIndex] ||= []).push(p);
  }
  const hits = [];
  const nNorm = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const [pageIdx, items] of Object.entries(byPage)) {
    const concat = items.map(i => i.str).join(' ').replace(/\s+/g, ' ').toLowerCase();
    const idx = concat.indexOf(nNorm);
    if (idx === -1) continue;
    // Map `idx` back to an item. Rough approximation — first item whose
    // concat offset matches.
    let offset = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemLen = item.str.length + 1; // +1 for the joining space
      if (offset + itemLen > idx) {
        const totalWidth = Math.min(items.slice(i).reduce((s, it) => s + it.width, 0), needle.length * 5);
        hits.push({
          pageIndex: Number(pageIdx),
          x: item.x,
          y: item.y,
          width: Math.max(30, totalWidth),
          height: item.height,
        });
        break;
      }
      offset += itemLen;
    }
  }
  return hits;
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
 * Add a StrikeOut text-markup annotation over a single-line text rectangle.
 *
 * Round 5a scope: single-line single-page only. Multi-line / multi-page
 * support deferred to Round 5b.
 *
 * The QuadPoints array per PDF spec (PDF 1.7 §12.5.6.10) is 8 numbers per
 * quadrilateral: [x1 y1 x2 y2 x3 y3 x4 y4] in the order
 *   1 = top-left, 2 = top-right, 3 = bottom-left, 4 = bottom-right
 * (the spec's order is unusual; some viewers also accept TL,TR,BR,BL but
 * Adobe Acrobat prefers TL,TR,BL,BR per the spec).
 *
 * Coordinates are in PDF user-space, y measured from the bottom of the
 * page (matching pdf-lib convention; callers pass already-flipped y).
 *
 * @param {PDFDocument} pdfDoc       — pdf-lib document
 * @param {PDFPage}     page          — page to annotate
 * @param {object}      box           — { x, y, width, height } of the run
 * @param {string}      box.contents  — popup comment text (the external_comment)
 * @param {string}      box.author    — annotation author (T field)
 */
function addStrikeOutAnnotation(pdfDoc, page, { x, y, width, height, contents, author }) {
  const ctx = pdfDoc.context;
  const x1 = x;
  const y1 = y + height;        // top-left y (y is bottom of run)
  const x2 = x + width;
  const y2 = y + height;        // top-right
  const x3 = x;
  const y3 = y;                 // bottom-left
  const x4 = x + width;
  const y4 = y;                 // bottom-right

  // Spec order: TL, TR, BL, BR
  const quadPoints = [x1, y1, x2, y2, x3, y3, x4, y4];

  // Bounding rectangle: [llx, lly, urx, ury]
  const rect = [x, y, x + width, y + height];

  const annotDict = ctx.obj({
    Type: 'Annot',
    Subtype: 'StrikeOut',
    Rect: rect,
    QuadPoints: quadPoints,
    // Color in DeviceRGB — red, matching the visual style for the
    // (deprecated) drawn-line fallback. Most viewers honor this.
    C: [0.85, 0.2, 0.2],
    // Round 5a fix — text strings, not Names (Acrobat-strict)
    Contents: PDFHexString.fromText(String(contents || '')),
    T: PDFString.of(String(author || '')),
    F: 4,                          // Print flag — the annotation prints with the doc
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
