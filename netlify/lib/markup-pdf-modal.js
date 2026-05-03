/**
 * PDF markup via the PyMuPDF Modal service.
 *
 * Calls the Python function deployed at MODAL_PDF_MARKUP_URL (set in
 * Netlify env vars) which uses PyMuPDF to write real /Subtype /StrikeOut
 * annotations + sticky comments — replacing the broken drawn-line
 * approach in netlify/lib/markup-pdf.js.
 *
 * Auth: shared token via MARKUP_SHARED_TOKEN env var. Both sides must
 * have the same value (set via `modal secret create legal-overflow-markup
 * MARKUP_SHARED_TOKEN=...` on the Python side, and netlify env on this
 * side).
 *
 * Falls back gracefully when MODAL_PDF_MARKUP_URL is not configured —
 * delegates to the legacy drawn-line markup-pdf.js so the system keeps
 * working even if the Python service is down or env vars aren't set.
 */
import { applyPdfMarkup as applyPdfMarkupLegacy } from './markup-pdf.js';

const MODAL_URL = process.env.MODAL_PDF_MARKUP_URL || '';
const SHARED_TOKEN = process.env.MARKUP_SHARED_TOKEN || '';

/**
 * Apply PDF markup. Same signature as applyPdfMarkup in markup-pdf.js,
 * so fanout-background.js can swap callers transparently.
 *
 * @param {Buffer} pdfBuffer
 * @param {Array<Finding>} findings
 * @param {object} [options]
 * @param {string} [options.author='Legal Overflow']
 * @returns {Promise<{ buffer: Buffer, applied: number, unanchored: Finding[] }>}
 */
export async function applyPdfMarkup(pdfBuffer, findings, options = {}) {
  if (!MODAL_URL || !SHARED_TOKEN) {
    console.warn(
      '[markup-pdf-modal] MODAL_PDF_MARKUP_URL or MARKUP_SHARED_TOKEN not set — ' +
      'falling back to legacy drawn-line markup. PDF redlines will look broken.',
    );
    return applyPdfMarkupLegacy(pdfBuffer, findings, options);
  }

  const author = (options.author && String(options.author).trim()) || 'Legal Overflow';

  const body = JSON.stringify({
    token: SHARED_TOKEN,
    pdf_b64: pdfBuffer.toString('base64'),
    findings,
    author,
  });

  let resp;
  try {
    resp = await fetch(MODAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    console.error('[markup-pdf-modal] Modal request failed, falling back:', err.message);
    return applyPdfMarkupLegacy(pdfBuffer, findings, options);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(
      `[markup-pdf-modal] Modal returned ${resp.status}: ${errText.slice(0, 200)}. Falling back.`,
    );
    return applyPdfMarkupLegacy(pdfBuffer, findings, options);
  }

  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    console.error('[markup-pdf-modal] Modal response was not JSON, falling back:', err.message);
    return applyPdfMarkupLegacy(pdfBuffer, findings, options);
  }

  if (!payload?.pdf_b64) {
    console.error('[markup-pdf-modal] Modal response missing pdf_b64, falling back');
    return applyPdfMarkupLegacy(pdfBuffer, findings, options);
  }

  return {
    buffer: Buffer.from(payload.pdf_b64, 'base64'),
    applied: payload.applied ?? 0,
    unanchored: payload.unanchored ?? [],
  };
}
