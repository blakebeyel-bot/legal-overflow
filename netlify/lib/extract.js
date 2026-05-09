/**
 * Document text extraction — JS port of scripts/extract_document.py.
 *
 * Produces canonical plain text that specialists can quote verbatim.
 * Format-aware: DOCX via mammoth (raw text), PDF via pdf-parse.
 *
 * Rule from CLAUDE.md §4.4: format in = format out. This module NEVER
 * converts formats — it only extracts text. The original file bytes go
 * to the appropriate markup module later.
 *
 * Scanned PDFs (DocuSign-style, image-only) used to be rejected outright.
 * They are now routed through Gemini Flash 2.5 Vision OCR (see
 * `netlify/lib/ocr.js`) so the contract review pipeline can read them
 * directly. The caller passes a `userId` so the OCR module can resolve
 * a BYOK Google key (preferred) or fall back to GOOGLE_AI_API_KEY.
 */
import mammoth from 'mammoth';
import { ocrPdf, resolveOcrKey, shouldOcrPdf } from './ocr.js';
// pdfjs-dist is lazy-loaded inside extractPdf() (see below). Static import
// at the top caused a prod cold-start failure because esbuild's handling
// of pdfjs-dist's dynamic worker import was fragile — DOCX uploads died
// before the function even ran. Lazy-loading keeps the module off the
// critical path for non-PDF files.

export const SCANNED_PDF_MIN_CHARS = 200;

/**
 * Extract canonical text from a file buffer.
 *
 * @param {Buffer} buffer    — raw file bytes
 * @param {string} filename  — used to infer format from extension
 * @param {object} [opts]
 * @param {string} [opts.userId]  — used by the OCR fallback to resolve a
 *                                   BYOK Google key. Optional; without it
 *                                   we fall back to the server env key.
 * @returns {Promise<{ text: string, format: 'docx'|'pdf'|'txt', pages?: number, ocr?: boolean }>}
 * @throws if format is unsupported, file is corrupt, or PDF is scanned AND
 *         OCR also fails (the rare double-failure case).
 */
export async function extractDocumentText(buffer, filename, opts = {}) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'docx') {
    return await extractDocx(buffer);
  }
  if (ext === 'pdf') {
    return await extractPdf(buffer, opts);
  }
  if (ext === 'txt' || ext === 'md') {
    return { text: buffer.toString('utf8'), format: 'txt' };
  }
  if (ext === 'doc') {
    throw new Error(
      'Legacy .doc binary Word format is not supported directly. ' +
      'Please save as .docx and re-upload.'
    );
  }
  throw new Error(`Unsupported file format: .${ext}. Supported: .docx, .pdf, .txt, .md`);
}

async function extractDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    if (text.length < 50) {
      throw new Error('DOCX contains almost no extractable text — file may be corrupt or empty.');
    }
    return { text, format: 'docx' };
  } catch (err) {
    throw new Error(`DOCX extraction failed: ${err.message}`);
  }
}

async function extractPdf(buffer, opts = {}) {
  // pdfjs-dist v5+ expects DOMMatrix / Path2D / ImageData on globalThis.
  // Its own auto-polyfill via @napi-rs/canvas is unreliable in Netlify
  // Functions: pdfjs evaluates `const SCALE_MATRIX = new DOMMatrix();`
  // at module load time (top-level), which runs BEFORE the polyfill block
  // can locate canvas. The result is "DOMMatrix is not defined" thrown
  // during the import itself — before our extractPdf code ever runs.
  //
  // Define minimal stubs on globalThis BEFORE the pdfjs import. Text
  // extraction (getTextContent) only needs the constructor to exist;
  // it never invokes the matrix methods. Canvas-rendering code paths
  // that DO use the methods are not hit by text extraction.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        // Minimal 2D affine identity — enough to satisfy pdfjs's
        // top-level `new DOMMatrix()` at line 17027 of pdf.mjs.
        // 2D-affine fields: a, b, c, d, e, f.
        if (Array.isArray(init) && init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        } else {
          this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        }
      }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = class Path2D {};
  }
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData {
      constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
    };
  }
  // Lazy-load pdfjs-dist so a broken PDF dependency can't kill the whole
  // function at cold start. Only PDF uploads pay the import cost.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let pdf;
  try {
    const uint8 = new Uint8Array(buffer);
    pdf = await pdfjsLib.getDocument({ data: uint8, disableFontFace: true }).promise;
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(itemsToParagraphedText(content.items));
  }
  const text = pageTexts.join('\n\n').trim();

  // Scanned / image-only PDF (DocuSign-completed contracts, faxes, etc.):
  // text layer is essentially empty, so OCR the file with Gemini Flash 2.5
  // Vision and use that markdown instead. ocr.js already has the per-page
  // chunking, prompt, and Gemini wiring used by the citation-verifier vault
  // — we just call it here with the user's BYOK key (or server fallback).
  if (shouldOcrPdf({ extractedText: text, pageCount: pdf.numPages })) {
    console.warn(`[extract] PDF text layer sparse (${text.length} chars / ${pdf.numPages} pages) — falling back to OCR`);
    try {
      const apiKey = await resolveOcrKey({ userId: opts.userId || null });
      if (!apiKey) {
        throw new Error(
          `PDF appears to be scanned or image-only (only ${text.length} extractable characters), ` +
          'and no Google API key is available for OCR fallback. ' +
          'Add a Google AI Studio key in your settings, or upload a native (non-scanned) PDF.'
        );
      }
      const ocrText = await ocrPdf({ pdfBytes: new Uint8Array(buffer), apiKey });
      const trimmed = (ocrText || '').trim();
      if (trimmed.length < SCANNED_PDF_MIN_CHARS) {
        throw new Error(
          `OCR completed but produced only ${trimmed.length} characters — the document may be blank, ` +
          'too low-resolution to read, or image-corrupt. Please supply a higher-quality scan or a native PDF.'
        );
      }
      console.log(`[extract] OCR fallback recovered ${trimmed.length} chars from ${pdf.numPages}-page scanned PDF`);
      return { text: trimmed, format: 'pdf', pages: pdf.numPages, ocr: true };
    } catch (err) {
      // Re-throw with a clearer message so the user sees both: text-layer
      // was sparse AND OCR couldn't recover it. Original detection message
      // is preserved as a fallback if OCR throws cleanly.
      throw new Error(
        `PDF appears to be scanned or image-only (only ${text.length} extractable characters), ` +
        `and OCR fallback failed: ${err.message}`
      );
    }
  }
  return { text, format: 'pdf', pages: pdf.numPages };
}

/**
 * Convert a page's pdfjs text items into paragraph-structured text.
 *
 * Round 2 — fix for the PDF/DOCX paragraph-structure divergence
 * identified in Round 1 reasoning verification. The previous extractor
 * joined all items on a page with single spaces, collapsing every
 * paragraph break within a page. Specialists then read PDF input as
 * one wall of text per page (8 paragraphs total for an 8-page contract
 * vs. 75 for the equivalent .docx), and reasoning quality dropped:
 * EXEMPLARY findings went from 5 to 0 on identical word content.
 *
 * Algorithm:
 *
 *   1. Group consecutive items into "lines" by y-coordinate. Items
 *      whose y is within ~40% of the item height of the current line
 *      belong to the same line (justified text has small jitter).
 *   2. Compute the median line-to-line y-gap. This adapts to the
 *      document's actual line spacing rather than guessing.
 *   3. Insert a paragraph break (`\n\n`) wherever the gap to the next
 *      line exceeds 1.3× the median gap, OR the previous line ended
 *      with an `hasEOL` marker followed by a non-trivial vertical gap.
 *   4. Negative gaps (cursor moved upward, e.g., footnote → body
 *      ordering glitch) are treated as paragraph breaks defensively.
 *
 * The 1.3× threshold is chosen to catch typical Word-export paragraph
 * spacing (6pt before / 12pt after, on top of line-height) while
 * leaving justified-text line wraps alone. In practice it converts
 * "8 paragraphs per page" into the 70-80 range that matches the .docx
 * extraction.
 */
function itemsToParagraphedText(items) {
  if (!items || !items.length) return '';

  // ---- Step 1: group items into lines by y-coordinate ----------------
  const lines = [];
  let cur = null;
  for (const it of items) {
    const str = it.str || '';
    const hasEol = !!it.hasEOL;
    if (!str && !hasEol) continue;

    const y = (it.transform && it.transform[5]) || 0;
    const h = it.height || 0;

    // Tolerance for "same line" — sub-pixel jitter on justified text.
    // Use 40% of the item's height (or current line's height) so a
    // 12pt line accepts ~5pt of vertical jitter.
    const tol = Math.max(2, ((cur && cur.h) || h || 12) * 0.4);

    if (cur && Math.abs(cur.y - y) <= tol) {
      cur.parts.push(str);
      if (hasEol) cur.eol = true;
    } else {
      if (cur) lines.push(cur);
      cur = { y, h: h || (cur ? cur.h : 12), parts: [str], eol: hasEol };
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) return '';

  // ---- Step 2: derive the document's typical line gap -----------------
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  // Use median to be robust against outliers (headings, blank-line gaps).
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
  // 1.3× median catches typical paragraph spacing (line-height + ~6pt
  // before-paragraph). Keep an absolute floor so very tight documents
  // don't classify line wraps as paragraph breaks.
  const paraThreshold = Math.max(medianGap * 1.3, medianGap + 4);

  // ---- Step 3: emit paragraphs --------------------------------------
  const paragraphs = [];
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineText = ln.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!lineText) continue;

    if (i > 0) {
      const gap = lines[i - 1].y - ln.y;
      // Positive gap above threshold OR negative gap (cursor moved up,
      // unusual reading-order glitch) → paragraph break.
      //
      // NOTE: pdfjs `hasEOL` is set on every wrapped line ending (not
      // just semantic paragraph ends), so it is NOT a usable paragraph
      // signal. Vertical-gap heuristic alone is the right tool.
      const isParaBreak = gap > paraThreshold || gap < -medianGap * 0.5;
      if (isParaBreak) {
        if (buf.length) paragraphs.push(buf.join(' '));
        buf = [];
      }
    }
    buf.push(lineText);
  }
  if (buf.length) paragraphs.push(buf.join(' '));
  return paragraphs.join('\n\n');
}
