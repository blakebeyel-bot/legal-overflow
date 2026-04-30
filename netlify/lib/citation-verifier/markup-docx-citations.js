/**
 * Citation Verifier — Pass 5b DOCX markup adapter.
 *
 * Per BUILD_SPEC §12.2a: tracked changes (<w:del>+<w:ins>) for ▲ flags
 * with suggested_fix, comment-only annotations for ✗ flags and
 * existence-check failures.
 *
 * Delegates the OOXML heavy lifting to lib/markup-docx.js (paragraph
 * location, run splitting, comment-file writes, post-assembly
 * Accept-All verification — all already battle-tested by the contract
 * reviewer). The mapping from "citation+flag" → "Finding" lives in
 * markup-shared.js so the PDF adapter reuses it.
 */

import { applyDocxMarkup } from '../markup-docx.js';
import { buildFindings, formatCommentBody } from './markup-shared.js';

export { buildFindings, formatCommentBody }; // re-export for tests / consumers

/**
 * Apply citation-verifier flags to a DOCX buffer.
 *
 * @param {Buffer} docxBuffer
 * @param {Array<EnrichedCitation>} citations
 * @returns {Promise<{ buffer, applied, unanchored }>}
 */
export async function applyCitationMarkupDocx(docxBuffer, citations) {
  const findings = buildFindings(citations);
  return await applyDocxMarkup(docxBuffer, findings);
}
