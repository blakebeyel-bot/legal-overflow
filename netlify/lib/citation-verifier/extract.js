/**
 * Citation Verifier — Pass 1 orchestrator.
 *
 * Single entry point for the pipeline. Dispatches to the right
 * format-specific extractor and returns a uniform result shape that the
 * rest of the pipeline can consume regardless of source format.
 *
 * Privilege-default hashing (BUILD_SPEC §16)
 * ------------------------------------------
 * Every candidate gets a SHA-256 hash of its candidate_text. The hash is
 * what we persist to the `citations` table by default; the raw text is
 * only stored if `retain_text` is true on the run. The hash is computed
 * here at extraction time so downstream code never needs to "re-hash if
 * not present" — it can rely on the field being set.
 *
 * Format dispatch
 * ---------------
 * Mirrors the existing site/netlify/lib/extract.js pattern (extension
 * sniff). We intentionally do NOT support .doc (legacy binary) or .txt
 * here — citation verification is only meaningful on the formats the
 * markup pipeline can re-emit (.docx and .pdf), per "format in = format
 * out" in CLAUDE.md §4.4.
 */

import { createHash } from 'node:crypto';
import { extractDocxForCitations } from './extract-docx.js';
import { extractPdfForCitations } from './extract-pdf.js';

/**
 * Top-level Pass 1 entry point.
 *
 * @param {Buffer} buffer — raw uploaded file bytes
 * @param {string} filename — used to infer format
 * @returns {Promise<Pass1Result>}
 *
 * Pass1Result:
 *   {
 *     text:        string,       // canonical plain text
 *     format:      'docx'|'pdf',
 *     file_hash:   string,       // SHA-256 of the FILE (not the text)
 *     pages?:      int,          // PDFs only
 *     page_starts?: int[],       // PDFs only
 *     footnotes?:  Array<{num,text}>,  // DOCX only
 *     candidates:  Array<Candidate>,
 *   }
 *
 * Candidate (per Pass 1 spec):
 *   {
 *     pattern_name:        string,
 *     provisional_type:    'case'|'statute'|'regulation'|'constitutional'
 *                          |'short_form_id'|'short_form_supra'|'short_form_case',
 *     candidate_text:      string,
 *     candidate_text_hash: string,  // SHA-256 hex of candidate_text
 *     char_start:          int,
 *     char_end:            int,
 *     page_number:         int|null,
 *     in_footnote:         boolean,
 *     footnote_num:        int|null,
 *     pre_context:         string,
 *     post_context:        string,
 *   }
 */
export async function extractForCitations(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  let result;
  if (ext === 'docx') {
    result = await extractDocxForCitations(buffer);
  } else if (ext === 'pdf') {
    result = await extractPdfForCitations(buffer);
  } else if (ext === 'doc') {
    throw new Error(
      'Legacy .doc binary Word format is not supported. Please save as .docx and re-upload.'
    );
  } else {
    throw new Error(
      `Unsupported file format: .${ext}. Citation verification supports .docx and .pdf only.`
    );
  }

  // SHA-256 of the original file bytes (for de-dup + audit, persisted
  // to verification_runs.file_hash).
  const fileHash = sha256Hex(buffer);

  // Hash every candidate's text. Done in-place — cheaper than rebuilding
  // the array.
  for (const c of result.candidates) {
    c.candidate_text_hash = sha256Hex(Buffer.from(c.candidate_text, 'utf8'));
  }

  return { ...result, file_hash: fileHash };
}

/**
 * SHA-256 hex digest. Module-local so we don't drag in a hashing
 * abstraction layer.
 */
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
