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
 * Rule from CLAUDE.md §4.7: scanned PDFs (<200 chars extractable) are
 * rejected here, not silently processed to produce bad redlines.
 */
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// The legacy build ships with a fake worker that runs inline in Node —
// no GlobalWorkerOptions.workerSrc assignment needed.

export const SCANNED_PDF_MIN_CHARS = 200;

/**
 * Extract canonical text from a file buffer.
 *
 * @param {Buffer} buffer   — raw file bytes
 * @param {string} filename — used to infer format from extension
 * @returns {Promise<{ text: string, format: 'docx'|'pdf'|'txt', pages?: number }>}
 * @throws if format is unsupported, file is corrupt, or PDF appears scanned
 */
export async function extractDocumentText(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'docx') {
    return await extractDocx(buffer);
  }
  if (ext === 'pdf') {
    return await extractPdf(buffer);
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

async function extractPdf(buffer) {
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
    pageTexts.push(content.items.map(it => it.str || '').join(' '));
  }
  const text = pageTexts.join('\n\n').trim();
  if (text.length < SCANNED_PDF_MIN_CHARS) {
    throw new Error(
      `PDF appears to be scanned or image-only (only ${text.length} extractable characters). ` +
      'Please re-OCR externally and re-upload, request a native file from the counterparty, ' +
      'or agree to a review-letter-only approach.'
    );
  }
  return { text, format: 'pdf', pages: pdf.numPages };
}
