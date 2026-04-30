/**
 * Citation Verifier — Pass 1 PDF extractor.
 *
 * Produces:
 *   { text, format: 'pdf', pages, page_starts, candidates }
 *
 * Where:
 *   - `text` is the canonical body text (one big string; pages joined with \n\n)
 *   - `pages` is the page count
 *   - `page_starts` is an array of length `pages`, where page_starts[i] is
 *     the half-open char_start of page (i+1) inside `text`. This is what
 *     lets us compute page_number from any candidate's char_start.
 *   - `candidates` is the citation-candidate array, with `page_number` set
 *     on each.
 *
 * Lazy-load pdfjs-dist (mirrors lib/extract.js)
 * --------------------------------------------
 * pdfjs-dist's dynamic worker import broke esbuild bundling at one point;
 * the existing extract.js lazy-loads inside the function. We do the same
 * here so a docx-only run never pays the pdfjs import cost.
 *
 * Scanned-PDF rejection (CLAUDE.md §4.7)
 * --------------------------------------
 * If the extractable text is shorter than SCANNED_PDF_MIN_CHARS we throw
 * — the citation verifier cannot meaningfully run on an image-only PDF.
 * The user-facing error suggests OCRing externally first.
 */

import { findCitationCandidates, dropContainedDuplicates } from './citation-patterns.js';

const SCANNED_PDF_MIN_CHARS = 200;
const PAGE_SEPARATOR = '\n\n';

/**
 * Extract PDF body text + page boundaries + citation candidates.
 *
 * @param {Buffer} buffer
 * @returns {Promise<ExtractPdfResult>}
 */
export async function extractPdfForCitations(buffer) {
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
    pageTexts.push(content.items.map((it) => it.str || '').join(' '));
  }

  // Build page_starts as a prefix-sum. page_starts[i] = char offset of
  // page (i+1) inside the joined text.
  const pageStarts = [];
  let cursor = 0;
  for (const pt of pageTexts) {
    pageStarts.push(cursor);
    cursor += pt.length + PAGE_SEPARATOR.length;
  }

  const text = pageTexts.join(PAGE_SEPARATOR).trim();
  if (text.length < SCANNED_PDF_MIN_CHARS) {
    throw new Error(
      `PDF appears to be scanned or image-only (only ${text.length} extractable characters). ` +
      'Please OCR externally and re-upload, or supply a native digital PDF.'
    );
  }

  const candidates = findCitationCandidates(text).map((c) => ({
    ...c,
    in_footnote: false, // PDFs don't expose footnote structure to extractors
    footnote_num: null,
    page_number: pageNumberFor(c.char_start, pageStarts),
  }));

  return {
    text,
    format: 'pdf',
    pages: pdf.numPages,
    page_starts: pageStarts,
    candidates: dropContainedDuplicates(candidates),
  };
}

/**
 * Given a char offset and the page_starts array, return the 1-based page
 * number that contains that offset. Used by both the extractor (above)
 * and downstream pdf markup (sticky-note placement) so they agree on
 * which page each citation lives on.
 */
export function pageNumberFor(charOffset, pageStarts) {
  if (!pageStarts || pageStarts.length === 0) return null;
  // Binary search would be O(log n) but page counts are small; linear
  // scan is fine and easier to read.
  for (let i = 0; i < pageStarts.length; i++) {
    const next = i + 1 < pageStarts.length ? pageStarts[i + 1] : Infinity;
    if (charOffset >= pageStarts[i] && charOffset < next) {
      return i + 1;
    }
  }
  return pageStarts.length; // fall through — last page
}
