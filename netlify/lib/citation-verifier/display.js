/**
 * Citation Verifier — citation display formatter.
 *
 * Builds a human-readable citation string from the structured components
 * Pass 2 emits. Used everywhere the verbatim candidate_text isn't
 * available (privilege default = retain_text=false stores null in the
 * candidate_text column).
 *
 * Display priority:
 *   1. If candidate_text is present (retain_text=true), use it verbatim.
 *   2. Otherwise build a "reconstructed" citation from components so the
 *      attorney can still recognize which cite the report is talking
 *      about by reference to the original draft.
 *   3. Fall back to "(text not retained — see draft at <location>)" only
 *      when there are no usable components either.
 */

/**
 * @param {object} citation — has candidate_text, citation_type, components,
 *                             page_number, in_footnote, footnote_num, char_start
 * @returns {string} display-ready citation
 */
export function formatCitationDisplay(citation) {
  if (!citation) return '';

  // 1. Verbatim wins when available.
  if (citation.candidate_text && typeof citation.candidate_text === 'string' && citation.candidate_text.trim()) {
    return citation.candidate_text.trim();
  }

  // 2. Reconstruct from components by citation_type.
  const reconstructed = reconstructFromComponents(citation);
  if (reconstructed) return reconstructed;

  // 3. Last-resort placeholder with location so the attorney can find it
  //    in the draft.
  return `(text not retained — see draft at ${formatLocation(citation)})`;
}

function reconstructFromComponents(c) {
  const t = c.citation_type;
  const cmp = c.components || {};

  if (t === 'case') {
    // Brown v. Bd. of Educ., 347 U.S. 483, 495 (1954)
    const parts = [];
    if (cmp.case_name) parts.push(cmp.case_name);
    const cite = [cmp.volume, cmp.reporter, cmp.first_page].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
    if (cite) parts.push(cite);
    if (cmp.pin_cite) parts.push(`at ${cmp.pin_cite}`);
    let s = parts.join(', ').replace(/, at /, ', '); // "X, Y, at Z" → "X, Y, Z"

    const paren = cmp.court_parenthetical || (cmp.year ? String(cmp.year) : null);
    if (paren) {
      // If the court parenthetical already includes the year just wrap it.
      // Otherwise build "(Court Year)".
      const open = paren.startsWith('(') ? '' : ' (';
      const close = paren.endsWith(')') ? '' : ')';
      s += `${open}${paren}${close}`;
    }
    if (cmp.signal) s = `${cmp.signal} ${s}`;
    return s.trim() || null;
  }

  if (t === 'statute') {
    // 42 U.S.C. § 1983 (2018)
    const parts = [];
    if (cmp.title) parts.push(String(cmp.title));
    if (cmp.code) parts.push(cmp.code);
    if (cmp.section) parts.push(`§ ${cmp.section}`);
    let s = parts.join(' ');
    if (cmp.year) s += ` (${cmp.year})`;
    return s.trim() || null;
  }

  if (t === 'regulation') {
    // 29 C.F.R. § 1630.2(g) (2024)
    const parts = [];
    if (cmp.title) parts.push(String(cmp.title));
    if (cmp.code) parts.push(cmp.code);
    if (cmp.section) parts.push(`§ ${cmp.section}`);
    let s = parts.join(' ');
    if (cmp.year) s += ` (${cmp.year})`;
    return s.trim() || null;
  }

  if (t === 'constitutional') {
    // U.S. Const. art. I, § 8, cl. 3
    const parts = [];
    parts.push((cmp.jurisdiction || 'U.S.') + ' Const.');
    if (cmp.article_or_amendment) parts.push(cmp.article_or_amendment);
    let s = parts.join(' ');
    if (cmp.section) s += `, § ${cmp.section}`;
    if (cmp.clause) s += `, cl. ${cmp.clause}`;
    return s.trim() || null;
  }

  if (t === 'short_form_id') {
    return cmp.pin_cite ? `Id. at ${cmp.pin_cite}` : 'Id.';
  }
  if (t === 'short_form_supra') {
    const ref = cmp.referent_name ? `${cmp.referent_name}, ` : '';
    const note = cmp.note ? ` note ${cmp.note}` : '';
    const pin = cmp.pin_cite ? `, at ${cmp.pin_cite}` : '';
    return `${ref}supra${note}${pin}`;
  }
  if (t === 'short_form_case') {
    const parts = [];
    if (cmp.case_short) parts.push(cmp.case_short);
    if (cmp.volume && cmp.reporter) parts.push(`${cmp.volume} ${cmp.reporter}`);
    if (cmp.pin_cite) parts.push(`at ${cmp.pin_cite}`);
    return parts.join(', ').trim() || null;
  }

  if (t === 'periodical' && cmp.periodical) {
    const parts = [];
    if (cmp.author) parts.push(cmp.author);
    if (cmp.title) parts.push(cmp.title);
    if (cmp.volume && cmp.periodical && cmp.first_page) {
      parts.push(`${cmp.volume} ${cmp.periodical} ${cmp.first_page}`);
    }
    if (cmp.year) parts.push(`(${cmp.year})`);
    return parts.join(', ').trim() || null;
  }

  if (t === 'book' && (cmp.author || cmp.title)) {
    const parts = [];
    if (cmp.author) parts.push(cmp.author);
    if (cmp.title) parts.push(cmp.title);
    if (cmp.section) parts.push(`§ ${cmp.section}`);
    if (cmp.year) parts.push(`(${cmp.year})`);
    return parts.join(', ').trim() || null;
  }

  // unknown / court_document / internet / etc — fall through.
  return null;
}

/**
 * Build a human-readable location string for a citation: page + footnote
 * marker if applicable.
 */
export function formatLocation(c) {
  if (!c) return '—';
  const parts = [];
  if (c.page_number != null) parts.push(`p.${c.page_number}`);
  if (c.in_footnote && c.footnote_num != null) parts.push(`fn.${c.footnote_num}`);
  return parts.join(' / ') || '—';
}
