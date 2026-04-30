/**
 * Citation Verifier — citation-state-tracker (Round 19).
 *
 * Walks the merged candidate stream (case + secondary + official extractors)
 * in document order and computes per-citation state:
 *
 *   • previous_citation     — the citation immediately before this one
 *   • is_string_cite        — true if multiple authorities separated by ;
 *   • authorities           — list of distinct case/source identifiers
 *   • paragraph_index       — 0-based paragraph index in document
 *   • case_state            — running per-case state:
 *       { last_full_cite_index, intervening_count }
 *   • hereinafter_registry  — declared hereinafter forms:
 *       { shortened_form: { first_full_cite_index, declared_at } }
 *
 * Brief 7's four deferred catches all rely on this state:
 *   • Id. antecedent mismatch (R. 4.1)
 *   • Id. after string cite (R. 4.1)
 *   • Short form after >5 intervening cites (R. 10.9)
 *   • supra without prior [hereinafter X] declaration (R. 4.2(b))
 *
 * The tracker is deterministic, stateless across runs, and runs once
 * per document. Output mutates each citation in place.
 */

import { sha256Hex } from './extract.js';

/**
 * Compute citation state for an array of citations sorted by char_start.
 *
 * @param {Array} citations — merged candidate list (Pass 1 + secondary + official)
 * @param {string} text — document body text (for paragraph indexing + name lookup)
 * @returns {Array} — same citations, mutated with state fields attached
 */
export function attachCitationState(citations, text) {
  if (!Array.isArray(citations) || citations.length === 0) return citations;

  // Sort by document position so "previous" is meaningful.
  const sorted = [...citations].sort((a, b) => (a.char_start || 0) - (b.char_start || 0));

  // Build paragraph index map.
  const paragraphBoundaries = [];
  if (text) {
    const re = /\n\s*\n/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      paragraphBoundaries.push(m.index);
    }
  }
  const getParagraphIndex = (offset) => {
    let p = 0;
    for (const b of paragraphBoundaries) {
      if (offset > b) p++;
      else break;
    }
    return p;
  };

  // Pre-scan document text for [hereinafter X] declarations and their
  // anchoring full-citation context. We register every "[hereinafter X]"
  // that appears in the text so the supra validator can confirm declaration.
  const hereinafterRegistry = {};
  if (text) {
    const hRe = /\[\s*hereinafter\s+([^\]]{1,80})\s*\]/gi;
    let m;
    while ((m = hRe.exec(text)) !== null) {
      const declared = m[1].trim();
      hereinafterRegistry[declared] = {
        first_declared_at: m.index,
        declared_text: declared,
      };
    }
  }

  // Per-case running state. Keyed by canonical short name (e.g., "Tamayo",
  // "Twombly"). Updated as we walk citations in document order.
  const caseState = {};

  // Walk in order, attaching state to each citation.
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;

    // Determine paragraph index.
    c._state_paragraph_index = getParagraphIndex(c.char_start || 0);

    // is_string_cite: TWO ways to be a string-cite member:
    //   (1) candidate_text itself contains multiple authorities separated
    //       by `; ` (single-candidate string cite)
    //   (2) text immediately preceding char_start contains `; ` (this
    //       citation is the next member of a multi-candidate string cite,
    //       separated from the previous in the source by ", ; " not ". ")
    const candText = c.candidate_text || '';
    const semicolonAuthorities = (candText.match(/;\s+(?:[A-Z][^,]{2,80}?\s+v\.|[A-Z][\w'.\-]+,)/g) || []).length;
    let isStringCite = semicolonAuthorities >= 1;
    // Check (2): is this citation immediately preceded in the source by `; `?
    if (!isStringCite && text && c.char_start > 0) {
      const before = text.slice(Math.max(0, c.char_start - 10), c.char_start);
      // "(YEAR); " or "PAGE); " precedes a string-cite continuation.
      if (/[)\d]\);\s*$/.test(before) || /;\s*$/.test(before)) {
        isStringCite = true;
        // Also mark the IMMEDIATELY PREVIOUS citation as a string-cite
        // member — it's the first member of the same string cite.
        if (i > 0) sorted[i - 1]._state_is_string_cite = true;
      }
    }
    c._state_is_string_cite = isStringCite;

    // authorities: list of distinct case/source short-names extractable from
    // candidate_text. We pull "<Word> v." occurrences as case-name tokens.
    const authorities = [];
    const authRe = /\b([A-Z][\w'.\-]+)\s+v\./g;
    let am;
    while ((am = authRe.exec(candText)) !== null) {
      authorities.push(am[1]);
    }
    c._state_authorities = authorities;

    // Identify the canonical case "short name" for this citation. For case
    // candidates, this is the first author word before " v.". For other
    // types, we don't track per-case state.
    let caseShortName = null;
    if (c.citation_type === 'case' || c.citation_type === 'short_form_case' ||
        c.provisional_type === 'case' || c.provisional_type === 'short_form_case') {
      const m1 = candText.match(/\b([A-Z][\w'.\-]+)\s+v\./);
      if (m1) caseShortName = m1[1];
      else {
        // Short forms like "Tamayo, 526 F.3d at 1075" — take first word.
        const m2 = candText.match(/^\s*(?:See\s+|Cf\.\s+|But\s+see\s+)?([A-Z][\w'.\-]+),\s*\d+\s+[A-Z]/);
        if (m2) caseShortName = m2[1];
      }
    }
    c._state_case_short_name = caseShortName;

    // Update per-case state.
    if (caseShortName) {
      // Full-cite detection: a full case citation has the structure
      // "<Name>, <Vol> <Reporter> <Page>(, <Pin>)? (<Court Year>)" — i.e.,
      // it ends with a year-parenthetical AND has a volume+reporter+page
      // sequence. Short forms ("X, V Reporter at P") have "at" but no year
      // paren at the end. The court parenthetical can contain "(7th Cir.
      // 2008)" so we check for "YYYY)" at end (with optional whitespace).
      const isFullCite = /\b\d{4}\)\s*$/.test(candText.trim()) &&
                         /\b\d{1,4}\s+[A-Z][A-Za-z.\s\d]*\d{1,5}/.test(candText) &&
                         !/\bat\s+\d/.test(candText);
      if (!caseState[caseShortName]) {
        caseState[caseShortName] = {
          last_full_cite_index: isFullCite ? i : -1,
          intervening_count: 0,
          gap_warning_fired: false,
        };
      } else if (isFullCite) {
        caseState[caseShortName].last_full_cite_index = i;
        caseState[caseShortName].intervening_count = 0;
        // Reset the gap warning on full-cite repeat — writer just refreshed
        // the antecedent.
        caseState[caseShortName].gap_warning_fired = false;
      } else {
        // Short form. Intervening count is the number of OTHER citations
        // since the last full cite to this case.
        // We compute it on the fly: sum the citations between
        // last_full_cite_index and i that aren't to this case.
        const since = caseState[caseShortName].last_full_cite_index;
        let intervening = 0;
        if (since >= 0) {
          for (let j = since + 1; j < i; j++) {
            const other = sorted[j];
            if (other._state_case_short_name !== caseShortName) intervening++;
          }
        }
        caseState[caseShortName].intervening_count = intervening;
      }
    }

    // Update intervening counts for ALL other tracked cases (each
    // non-matching citation increments their counter, but we just
    // recompute on demand above so this is a no-op).

    // Attach previous_citation reference (lightweight — store a few key fields).
    c._state_previous = prev ? {
      index: i - 1,
      candidate_text: prev.candidate_text,
      citation_type: prev.citation_type || prev.provisional_type,
      is_string_cite: prev._state_is_string_cite,
      authorities: prev._state_authorities,
      case_short_name: prev._state_case_short_name,
      paragraph_index: prev._state_paragraph_index,
    } : null;

    // Attach hereinafter registry snapshot (read-only — same for all citations).
    c._state_hereinafter_registry = hereinafterRegistry;
    c._state_case_state = caseState[caseShortName] || null;
    c._state_index = i;
  }

  return sorted;
}
