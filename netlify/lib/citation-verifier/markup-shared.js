/**
 * Citation Verifier — markup helpers shared by DOCX + PDF adapters.
 *
 * The format-specific adapters (`markup-docx-citations.js`,
 * `markup-pdf-citations.js`) both feed the same engine-side `Finding`
 * shape into lib/markup-docx.js or lib/markup-pdf.js. The transformation
 * from "citation + flags + existence result" → "Finding objects" is
 * IDENTICAL across formats, so it lives here.
 *
 * Banned-phrase rule (BUILD_SPEC §16): every external_comment is run
 * through sanitizeOutput before leaving this module.
 */

import { sanitizeOutput } from './skill-prompt.js';

/**
 * Convert citation+flag pairs into the `Finding` objects that
 * applyDocxMarkup / applyPdfMarkup consume.
 *
 * Round 6.8 / hard constraint: NEVER modify the document body. The
 * citation verifier writes only to word/comments.xml and the comment
 * range markers in document.xml. No tracked-change <w:del>/<w:ins>,
 * no inserted text, no replacements. Every finding is comment-only.
 *
 *   • Every flag → markup_type='annotate' (comment only)
 *   • Suggested fix appears in the comment BODY, not as inserted text
 *   • One comment per distinct rule violation per citation
 *
 * Document text is read-only. The drafting attorney is the sole agent
 * authorized to change the underlying citation text.
 */
export function buildFindings(citations) {
  const findings = [];

  for (const c of citations) {
    if (!c.candidate_text) continue;

    const flags = Array.isArray(c.flags) ? c.flags : [];

    // Comment range — must enclose the FULL citation including any
    // italicized case name. Round 6.9 fix: when components.case_name
    // is present but candidate_text doesn't include it (because Pass 1's
    // reach-back missed it), expand the search target to the full case
    // name + cite. The DOCX locator handles plain-text matching across
    // formatted runs, so this lands the comment range correctly even
    // when the case name is italicized in a separate run.
    const sourceText = pickAnchorSpan(c);

    // ROUND 6.8 — every flag becomes a comment. No tracked changes,
    // no document-body modifications. Suggested fix lives in the
    // comment body only.
    //
    // Round 7 — REMOVED the local existenceToFlag synthesis path that
    // used to live here. It was bypassing the suppression rule: when
    // the orchestrator correctly dropped the existence flag (because
    // Pipeline A had flagged the citation), this code re-synthesized
    // it independently, defeating the suppression. The orchestrator
    // is now the SOLE source of existence-category flags. Markup
    // just consumes c.flags as-is.
    for (const f of flags) {
      findings.push({
        markup_type: 'annotate',
        source_text: sourceText,
        anchor_text: sourceText,
        external_comment: sanitizeOutput(formatCommentBody(f, c.existence)),
      });
    }
  }

  return findings;
}

/**
 * Pick the anchor span for a citation — the text the comment range will
 * enclose in the DOCX.
 *
 * Round 12 — ALWAYS use candidate_text verbatim. The previous version
 * tried to prepend `components.case_name` when it wasn't already in
 * candidate_text, but Sonnet sometimes returns a "corrected" case
 * name (e.g., `"Ashcroft v. Iqbal"` for a brief that wrote
 * `"Ashcroft v Iqbal"` without the period). String-equality check
 * `candidate.includes(caseName)` failed → function returned the
 * concatenation `"Ashcroft v. Iqbal, Ashcroft v Iqbal, 556 US 662
 * (2009)"` — a string that doesn't exist anywhere in the document.
 * markup-docx then marked the finding unanchored, dropping the
 * comment entirely. That was THE downstream filter the user pointed
 * to: validators fired correctly, but the malformed anchor span made
 * the comments invisible.
 *
 * Pass 1's reach-back is the authoritative source of the anchor:
 * when it captures the case name, candidate_text already includes
 * it. When reach-back can't (mid-sentence cite with no boundary),
 * we anchor on the volume/reporter/page span only — still produces
 * a visible comment, just narrower. That's strictly better than
 * "no comment" from a fabricated anchor.
 */
function pickAnchorSpan(citation) {
  return citation.candidate_text || '';
}

/**
 * Build the body of the Word comment / sticky-note for a flag.
 * Format mirrors BUILD_SPEC §12.2:
 *
 *     BB R. 10.2.2; T6 — case name "Corporation" must be abbreviated "Corp."
 *
 *     Suggested fix: Smith v. Acme Corp.
 */
export function formatCommentBody(flag, existence = null) {
  if (!flag) return '';
  const cite = [flag.rule_cite, flag.table_cite].filter(Boolean).join('; ');
  const lines = [];
  if (cite) lines.push(`${cite} — ${flag.message || ''}`.trim());
  else lines.push(flag.message || '');

  if (flag.suggested_fix) {
    lines.push('');
    lines.push(`Suggested fix: ${flag.suggested_fix}`);
  }

  // Round 7 — CourtListener search-URL trailer is appended ONLY on
  // Pipeline B (existence-category) comments. Pipeline A's format
  // findings have nothing to do with CL search results, and tacking
  // the URL onto a "missing v. period" comment was both irrelevant
  // and confusing. Also: the URL must be a human-browsable search,
  // not the API endpoint — court-listener.js builds it via
  // humanSearchUrl().
  if (flag.category === 'existence' && existence?.search_url) {
    lines.push('');
    lines.push(`CourtListener search: ${existence.search_url}`);
  }

  return lines.join('\n').trim();
}

// (Removed in Round 7 — the orchestrator's existenceResultToFlag in
//  court-listener.js is now the single source of existence flags.
//  Having a local copy here was bypassing the Pipeline-A suppression
//  rule and re-synthesizing UNRESOLVED comments after the orchestrator
//  correctly dropped them.)
