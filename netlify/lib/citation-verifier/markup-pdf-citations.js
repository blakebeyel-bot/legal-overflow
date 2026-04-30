/**
 * Citation Verifier — Pass 5c PDF markup adapter.
 *
 * Per BUILD_SPEC §12.2b: PDFs do not support tracked changes; we emit
 * strikethroughs (for ▲ replace) and sticky-note annotations only.
 *
 * Delegates to lib/markup-pdf.js for the pdf-lib annotation work. Uses
 * markup-shared.js for the citation-flag → Finding transformation so
 * the DOCX and PDF outputs agree on every comment body.
 *
 * Per CLAUDE.md §4.5 for PDFs: proposed replacement language lives
 * INSIDE the sticky-note body, not as a FreeText insertion box on the
 * page. The upstream applyPdfMarkup already enforces that.
 */

import { applyPdfMarkup } from '../markup-pdf.js';
import { buildFindings } from './markup-shared.js';

/**
 * Apply citation-verifier flags to a PDF buffer.
 *
 * @param {Buffer} pdfBuffer
 * @param {Array<EnrichedCitation>} citations
 * @returns {Promise<{ buffer, applied, unanchored }>}
 */
export async function applyCitationMarkupPdf(pdfBuffer, citations) {
  const findings = buildFindings(citations);
  return await applyPdfMarkup(pdfBuffer, findings);
}
