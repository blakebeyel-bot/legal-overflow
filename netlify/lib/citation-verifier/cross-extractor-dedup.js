/**
 * Citation Verifier — cross-extractor span dedup.
 *
 * Round 26 — multiple extractor types (case, foreign, official, secondary)
 * run independently against the same document text. They CAN produce
 * overlapping candidates for the same citation when one extractor's
 * walk-back stops at a different boundary than another's.
 *
 * Concrete failure mode this module fixes (the user's edge-case stress
 * test brief): the case extractor produced a Chevron candidate spanning
 * the FULL case-name "Chevron U.S.A., Inc. v. Nat. Res. Def. Council,
 * Inc., 467 U.S. 837, 842-43 (1984)". The secondary-source extractor's
 * book heuristic accepted "Council, Inc., 467 U.S. 837, 842-43 (1984)"
 * (truncated to the second corporate party). Both candidates flowed
 * through Pass 3, both fired R. 3.2(a) on "842-43", and the user saw
 * two comments — one with the correct full-case-name fix, one with a
 * malformed "Council, Inc., ..." fix.
 *
 * Priority order (highest → lowest):
 *
 *   case > foreign > official > secondary
 *
 * The "case" extractor (citation-patterns.js findCitationCandidates) is
 * the canonical source for case + statute + regulation + short-form
 * citations, so it always wins. Foreign sources outrank official/secondary
 * because the foreign extractor is the most specific (it knows treaty/ICJ
 * /ECHR patterns). Official outranks secondary because constitutional/
 * legislative/administrative cites are more structured than book/article/
 * news cites (which are catch-all secondary patterns).
 *
 * Behavior:
 *
 *   • Lower-priority candidate is FULLY CONTAINED within a higher-
 *     priority candidate's span → DROP the lower-priority candidate.
 *     ("Fully contained" includes equal-span: same start AND same end.)
 *   • Lower-priority candidate PARTIALLY OVERLAPS a higher-priority
 *     candidate (some overlap but neither contains the other) → KEEP
 *     both, but log the partial overlap as a WARNING. This shouldn't
 *     happen in practice; if it does, it indicates a separate bug.
 *   • No overlap → KEEP the lower-priority candidate.
 *
 * Returns the four extractor groups with lower-priority candidates
 * filtered, plus the list of partial-overlap warnings for the
 * orchestrator to log.
 */

/**
 * @typedef {object} ExtractorCandidate
 * @property {number} char_start
 * @property {number} char_end
 * @property {string} candidate_text
 * @property {string} pattern_name
 * @property {string} provisional_type
 */

/**
 * @typedef {object} PartialOverlap
 * @property {string} lower_extractor
 * @property {string} higher_extractor
 * @property {{ char_start: number, char_end: number, candidate_text: string }} lower
 * @property {{ char_start: number, char_end: number, candidate_text: string }} higher
 */

/**
 * Drop secondary/official/foreign candidates fully contained within a
 * higher-priority extractor's span. Log partial overlaps for diagnosis.
 *
 * @param {object} groups
 * @param {ExtractorCandidate[]} groups.caseCands     — pass1 case-extractor output (always kept)
 * @param {ExtractorCandidate[]} groups.foreignCands  — foreign-source extractor output
 * @param {ExtractorCandidate[]} groups.officialCands — official-source extractor output
 * @param {ExtractorCandidate[]} groups.secondaryCands — secondary-source extractor output
 * @returns {{
 *   caseCands: ExtractorCandidate[],
 *   foreignCands: ExtractorCandidate[],
 *   officialCands: ExtractorCandidate[],
 *   secondaryCands: ExtractorCandidate[],
 *   partialOverlaps: PartialOverlap[],
 * }}
 */
export function filterCrossExtractorOverlap({
  caseCands = [],
  foreignCands = [],
  officialCands = [],
  secondaryCands = [],
}) {
  const partialOverlaps = [];

  /**
   * Filter `lower` against all higher-priority groups. A lower candidate
   * is dropped if any higher candidate fully contains its span. Partial
   * overlaps are recorded as warnings but the lower candidate is kept.
   */
  function filterAgainstHigher(lower, higherGroups, lowerName) {
    return lower.filter((l) => {
      // Pass 1: contained-in-higher → drop.
      for (const { name: hName, list: hList } of higherGroups) {
        for (const h of hList) {
          if (h.char_start <= l.char_start && h.char_end >= l.char_end) {
            return false;
          }
        }
      }
      // Pass 2: partial overlap (neither contains the other) → keep + warn.
      for (const { name: hName, list: hList } of higherGroups) {
        for (const h of hList) {
          const overlaps = l.char_start < h.char_end && l.char_end > h.char_start;
          if (!overlaps) continue;
          const lowerInHigher = h.char_start <= l.char_start && h.char_end >= l.char_end;
          const higherInLower = l.char_start <= h.char_start && l.char_end >= h.char_end;
          if (lowerInHigher || higherInLower) continue; // contained — handled above
          partialOverlaps.push({
            lower_extractor: lowerName,
            higher_extractor: hName,
            lower: {
              char_start: l.char_start,
              char_end: l.char_end,
              candidate_text: l.candidate_text,
            },
            higher: {
              char_start: h.char_start,
              char_end: h.char_end,
              candidate_text: h.candidate_text,
            },
          });
        }
      }
      return true;
    });
  }

  // Apply priority order: case > foreign > official > secondary.
  const filteredForeign = filterAgainstHigher(
    foreignCands,
    [{ name: 'case', list: caseCands }],
    'foreign'
  );
  const filteredOfficial = filterAgainstHigher(
    officialCands,
    [
      { name: 'case', list: caseCands },
      { name: 'foreign', list: filteredForeign },
    ],
    'official'
  );
  const filteredSecondary = filterAgainstHigher(
    secondaryCands,
    [
      { name: 'case', list: caseCands },
      { name: 'foreign', list: filteredForeign },
      { name: 'official', list: filteredOfficial },
    ],
    'secondary'
  );

  return {
    caseCands,
    foreignCands: filteredForeign,
    officialCands: filteredOfficial,
    secondaryCands: filteredSecondary,
    partialOverlaps,
  };
}
