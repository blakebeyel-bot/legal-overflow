/**
 * Citation Verifier — suggested-fix self-check.
 *
 * Per round-6 spec from the user:
 *   "Before emitting any 'Suggested fix:' line:
 *      1. The fix must be a complete, well-formed citation, not a fragment.
 *      2. Run the proposed fix back through every rule check the tool
 *         implements. If the fix still fails any check, regenerate.
 *      3. If the fix cannot be generated cleanly (e.g., for fictional
 *         cases, missing pinpoints), emit no 'Suggested fix:' line —
 *         just the rule explanation."
 *
 * Concrete failures from round 5 / Titan brief that this guards:
 *   • Comments #3, #7: "Suggested fix: 482 F. Supp. 3d 217, 225 (D. Mass. 2020)"
 *     — case name dropped. The fix is unusable as a replacement; the
 *     attorney would have to reconstruct the case name themselves.
 *   • Comment #13: "Restatement of (Am. L. Inst. <year>)" — incoherent
 *     fragment.
 *
 * The check runs at the orchestrator level, AFTER applyStaticFixes,
 * BEFORE the flag is persisted. Returns either the cleaned-up
 * suggested_fix or null (omit the line).
 */

import { applyStaticFixes } from './compose-fixes.js';

/**
 * Validate a suggested_fix string against the citation it's meant to
 * correct. Returns:
 *   - the suggested_fix unchanged if it's complete and self-consistent
 *   - null if it's malformed and can't be salvaged (caller omits the line)
 *
 * @param {object} citation       — full classified citation with .citation_type, .components, .candidate_text
 * @param {string|null} suggestedFix
 * @returns {string|null}
 */
export function validateSuggestedFix(citation, suggestedFix) {
  if (!suggestedFix || typeof suggestedFix !== 'string') return null;
  const fix = suggestedFix.trim();
  if (fix.length < 10) return null;

  // Run static fixes a second time — the orchestrator already does this
  // once, but a defensive re-run ensures the output is fully canonical.
  const reapplied = applyStaticFixes(fix);

  // Detect leftover errors that should NEVER be in a "fixed" version.
  // If any of these still match, the fix didn't fully clean up and we
  // shouldn't surface it to the user as authoritative.
  const persistingErrors = [
    /\bvs\.?\s+[A-Z]/,                                    // "vs."
    /\b[A-Z][\w']+\s+v(?!\.)\s+[A-Z]/,                    // "v" no period
    /\b\d{1,4}\s+US\s+\d/,                                // "US" no periods
    /\b\d{1,4}\s+U\.S\s+\d(?!\d*\.)/,                     // "U.S" missing trailing period (heuristic)
    /\b\d{1,3}\s+USC\b/,                                  // "USC" no periods
    /\b\d{1,3}\s+CFR\b/,                                  // "CFR" no periods
    /§\d/,                                                  // section symbol no space
    /\bFRCP\b|\bFRCrP\b|\bFRAP\b|\bFRE\b/,                // Fed-rules shorthands
    /\bFl\.(?![A-Za-z])/,                                  // "Fl." instead of "Fla."
  ];
  for (const re of persistingErrors) {
    if (re.test(reapplied)) {
      // The fix still has a known error pattern — don't surface it.
      return null;
    }
  }

  // Type-specific completeness checks.
  if (citation && citation.citation_type === 'case') {
    // Case citations must have a case name (X v. Y) AND a reporter cite.
    // The Round-5 bug emitted "482 F. Supp. 3d 217, 225 (D. Mass. 2020)"
    // — fix without case name. Refuse to emit such fragments.
    const hasCaseName = /\b[A-Z][A-Za-z\-'\.]+\s+v\.\s+[A-Z]/.test(reapplied);
    const hasReporterCite = /\b\d+\s+[A-Z][A-Za-z\.\d\s]*\s+\d/.test(reapplied);

    // If the original candidate_text had a case name AND the fix dropped
    // it, the fix is incomplete. Original-had-case-name detected by the
    // same regex on candidate_text.
    const originalHadCaseName = citation.candidate_text &&
      /\b[A-Z][A-Za-z\-'\.]+\s+v\.?\s+[A-Z]/.test(citation.candidate_text);

    if (originalHadCaseName && !hasCaseName) {
      return null; // dropped the case name — unusable
    }
    if (!hasReporterCite) {
      return null; // missing the cite proper
    }
  }

  if (citation && citation.citation_type === 'book' &&
      /\bRestatement\b/.test(citation.candidate_text || '')) {
    // Restatement fixes must look like a complete Restatement citation:
    // "Restatement (X) of Y § Z (Am. L. Inst. YYYY)".
    // The Round-5 bug emitted "Restatement of (Am. L. Inst. <year>)" —
    // missing the series, missing the section, missing the subject.
    // Refuse if any required piece is absent.
    const hasSeries = /\bRestatement\s+\((First|Second|Third|Fourth)\)/.test(reapplied);
    const hasSubject = /\bof\s+[A-Z]/.test(reapplied);
    const hasSection = /§\s*\d/.test(reapplied);
    if (!hasSeries || !hasSubject || !hasSection) {
      return null;
    }
  }

  return reapplied;
}
