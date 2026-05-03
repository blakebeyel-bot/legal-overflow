/**
 * Text utilities for user-facing strings.
 *
 * The system uses snake_case and kebab-case identifiers internally
 * (database columns, JSON keys, agent slugs, classifier outputs like
 * "master_services_agreement" / "their_paper_high_leverage"). None of
 * those should ever appear raw in the UI or in downloadable documents
 * the customer reads. This file holds the small shared helper that
 * converts those identifiers to a clean human-facing label.
 *
 * Mirrored verbatim in src/pages/agents/contract-review.astro for
 * client-side use — both copies must stay in lockstep. If you change
 * the rules here, change them there too.
 */

/**
 * Acronyms that should render fully uppercase regardless of how the
 * underlying identifier was cased. Lowercase keys for matching after
 * we lower-case + tokenize the input.
 */
const ACRONYMS = new Set([
  'nda', 'mnda', 'msa', 'sow', 'po', 'mou', 'loi', 'sla', 'eula',
  'dpa', 'baa', 'ip', 'sa', 'tos', 'pdf', 'docx', 'csa', 'rfp',
]);

/**
 * Lowercase joiner words that stay lowercase when they appear in the
 * MIDDLE of a phrase. Always title-cased when they're the first word.
 * "Master Services Agreement with Exhibits" rather than "Master
 * Services Agreement With Exhibits".
 */
const LOWERCASE_JOINERS = new Set([
  'with', 'and', 'or', 'of', 'for', 'to', 'the', 'a', 'an', 'in', 'on',
]);

/**
 * Convert a snake_case / kebab-case / single-word identifier to a
 * human-facing label. Examples:
 *
 *   humanize("master_services_agreement")         → "Master Services Agreement"
 *   humanize("nda")                               → "NDA"
 *   humanize("subscription_agreement")            → "Subscription Agreement"
 *   humanize("their_paper_high_leverage")         → "Their Paper High Leverage"
 *   humanize("cross_section_hazard")              → "Cross Section Hazard"
 *   humanize("commercial-terms-analyst")          → "Commercial Terms Analyst"
 *   humanize("nda_with_exhibits")                 → "NDA with Exhibits"
 *   humanize("")                                  → ""
 *   humanize(null)                                → ""
 *
 * Idempotent: passing already-humanized text returns it essentially
 * unchanged ("Master Services Agreement" → "Master Services Agreement").
 */
export function humanize(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (!s) return '';
  // Split on _ and - (keep all-caps acronyms intact across either separator)
  const parts = s.split(/[_-]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map((part, i) => {
    const lower = part.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (i > 0 && LOWERCASE_JOINERS.has(lower)) return lower;
    // Preserve mixed-case tokens that are already cased intentionally
    // (e.g., "macOS"). If the original token has any uppercase letter
    // beyond position 0, leave it alone.
    if (/[A-Z]/.test(part.slice(1))) return part;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}
