/**
 * Round 26 — cross-extractor span dedup + corporate-suffix exclusion.
 *
 * The edge-case stress test brief reproducibly emitted a duplicate
 * Chevron R. 3.2(a) comment. Round 25's Pass-4 dedup couldn't catch
 * it because the duplicate was Pass 3 vs. Pass 3 — two different
 * extractors (case + secondary "book") both produced candidates that
 * overlapped on the same R. 3.2(a) violation, but with different
 * walk-back boundaries → different candidate_text → different
 * suggested_fix.
 *
 * Two fixes:
 *   (a) PRIMARY — orchestrator-level cross-extractor span dedup.
 *       Drops secondary/official/foreign candidates fully contained in
 *       a higher-priority extractor span (case > foreign > official >
 *       secondary).
 *   (b) BELT-AND-SUSPENDERS — looksLikeAuthorTitleStart rejects heads
 *       whose author/title prefix region contains a corporate-entity
 *       suffix (Inc., Corp., LLC, etc.). Real book authors don't
 *       carry corporate suffixes; case-party fragments do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterCrossExtractorOverlap } from '../cross-extractor-dedup.js';
import { findSecondarySourceCandidates } from '../secondary-source-patterns.js';
import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';
import { runAllValidators } from '../validators.js';

// ---------------------------------------------------------------------------
// (a) Cross-extractor span dedup
// ---------------------------------------------------------------------------

test('Round 26 — secondary candidate fully contained in case span is DROPPED', () => {
  const caseCands = [
    { char_start: 580, char_end: 661, candidate_text: 'Chevron U.S.A., Inc. v. Nat. Res. Def. Council, Inc., 467 U.S. 837, 842-43 (1984)', pattern_name: 'reporter', provisional_type: 'case' },
  ];
  const secondaryCands = [
    { char_start: 619, char_end: 661, candidate_text: 'Council, Inc., 467 U.S. 837, 842-43 (1984)', pattern_name: 'secondary-book', provisional_type: 'book' },
  ];
  const result = filterCrossExtractorOverlap({ caseCands, secondaryCands });
  assert.equal(result.secondaryCands.length, 0, 'Truncated "Council, Inc." secondary candidate must be dropped');
  assert.equal(result.partialOverlaps.length, 0);
});

test('Round 26 — equal-span case beats secondary (case wins ties)', () => {
  const span = { char_start: 100, char_end: 200, candidate_text: 'Foo v. Bar, 123 U.S. 1 (2020)' };
  const caseCands = [{ ...span, pattern_name: 'reporter', provisional_type: 'case' }];
  const secondaryCands = [{ ...span, pattern_name: 'secondary-book', provisional_type: 'book' }];
  const result = filterCrossExtractorOverlap({ caseCands, secondaryCands });
  assert.equal(result.caseCands.length, 1);
  assert.equal(result.secondaryCands.length, 0);
});

test('Round 26 — non-overlapping secondary candidates are KEPT', () => {
  const caseCands = [
    { char_start: 100, char_end: 200, candidate_text: 'Foo v. Bar, 123 U.S. 1 (2020)', pattern_name: 'reporter', provisional_type: 'case' },
  ];
  const secondaryCands = [
    { char_start: 300, char_end: 400, candidate_text: 'Cunningham, Securities Litigation Treatise § 12.04 (2d ed. 2022)', pattern_name: 'secondary-book', provisional_type: 'book' },
  ];
  const result = filterCrossExtractorOverlap({ caseCands, secondaryCands });
  assert.equal(result.secondaryCands.length, 1, 'Legitimate non-overlapping secondary must be kept');
  assert.equal(result.partialOverlaps.length, 0);
});

test('Round 26 — partial overlap (neither contains the other) is KEPT and LOGGED', () => {
  const caseCands = [
    { char_start: 100, char_end: 250, candidate_text: 'Case span', pattern_name: 'reporter', provisional_type: 'case' },
  ];
  const secondaryCands = [
    { char_start: 200, char_end: 300, candidate_text: 'Secondary span', pattern_name: 'secondary-book', provisional_type: 'book' },
  ];
  const result = filterCrossExtractorOverlap({ caseCands, secondaryCands });
  assert.equal(result.secondaryCands.length, 1, 'Partial overlap must keep the lower candidate');
  assert.equal(result.partialOverlaps.length, 1);
  assert.equal(result.partialOverlaps[0].lower_extractor, 'secondary');
  assert.equal(result.partialOverlaps[0].higher_extractor, 'case');
});

test('Round 26 — priority order: case > foreign > official > secondary', () => {
  const caseSpan     = { char_start: 0,   char_end: 100, candidate_text: 'case' };
  const foreignSpan  = { char_start: 200, char_end: 300, candidate_text: 'foreign' };
  const officialSpan = { char_start: 400, char_end: 500, candidate_text: 'official' };
  // secondary candidates that should be dropped because contained in higher
  const secInCase     = { char_start: 10, char_end: 50, candidate_text: 'sec-in-case' };
  const secInForeign  = { char_start: 210, char_end: 250, candidate_text: 'sec-in-foreign' };
  const secInOfficial = { char_start: 410, char_end: 450, candidate_text: 'sec-in-official' };
  const secStandalone = { char_start: 600, char_end: 700, candidate_text: 'sec-standalone' };
  const result = filterCrossExtractorOverlap({
    caseCands:      [{ ...caseSpan,     pattern_name: 'reporter',          provisional_type: 'case' }],
    foreignCands:   [{ ...foreignSpan,  pattern_name: 'foreign-case',      provisional_type: 'foreign_case' }],
    officialCands:  [{ ...officialSpan, pattern_name: 'official-fed-reg',  provisional_type: 'fed_reg' }],
    secondaryCands: [
      { ...secInCase,     pattern_name: 'secondary-book', provisional_type: 'book' },
      { ...secInForeign,  pattern_name: 'secondary-book', provisional_type: 'book' },
      { ...secInOfficial, pattern_name: 'secondary-book', provisional_type: 'book' },
      { ...secStandalone, pattern_name: 'secondary-book', provisional_type: 'book' },
    ],
  });
  assert.equal(result.secondaryCands.length, 1, 'Only the standalone secondary survives');
  assert.equal(result.secondaryCands[0].candidate_text, 'sec-standalone');
});

test('Round 26 — official candidate contained in foreign span is dropped', () => {
  const result = filterCrossExtractorOverlap({
    caseCands: [],
    foreignCands: [{ char_start: 100, char_end: 200, candidate_text: 'foreign', pattern_name: 'foreign-treaty', provisional_type: 'multilateral_treaty' }],
    officialCands: [{ char_start: 120, char_end: 180, candidate_text: 'inside foreign', pattern_name: 'official-something', provisional_type: 'fed_reg' }],
    secondaryCands: [],
  });
  assert.equal(result.officialCands.length, 0);
});

// ---------------------------------------------------------------------------
// (b) Corporate-suffix exclusion in looksLikeAuthorTitleStart
//
// findSecondarySourceCandidates is the only public entry; we use it to
// verify the exclusion is wired correctly. Each input below is a
// candidate fragment that the book extractor's tail regex would match.
// After Round 26, looksLikeAuthorTitleStart must reject heads whose
// first ~60 chars contain a corporate suffix.
// ---------------------------------------------------------------------------

const BOOK_SUFFIX_REJECTIONS = [
  ['Inc.',     'Council, Inc., 467 U.S. 837, 842-43 (1984)'],
  ['Inc.',     'Acme Holdings, Inc., Style Guide § 12 (3d ed. 2020)'],
  ['Corp.',    'Acme Corp., Style Guide § 12 (3d ed. 2020)'],
  ['Co.',      'Widgets Co., Catalog 3 (2018)'],
  ['LLC',      'Smith, LLC, Manual at 5 (2021)'],
  ['L.L.C.',   'Foo, L.L.C., Compendium 12 (2020)'],
  ['Ltd.',     'Bar, Ltd., Handbook 3 (2019)'],
  ['LLP',      'Baz, LLP, Treatise 5 (2018)'],
  ['L.L.P.',   'Qux, L.L.P., Guide 7 (2017)'],
  ['N.A.',     'Bank, N.A., Report 9 (2016)'],
  ['P.C.',     'Firm, P.C., Manual 11 (2015)'],
  ['P.A.',     'Group, P.A., Volume 13 (2014)'],
];

for (const [suffix, text] of BOOK_SUFFIX_REJECTIONS) {
  test(`Round 26 — book extractor rejects head with "${suffix}" suffix`, () => {
    const cands = findSecondarySourceCandidates(text);
    const asBook = cands.filter((c) => c.provisional_type === 'book');
    assert.equal(asBook.length, 0, `"${text}" must not be classified as book (head ends in ${suffix})`);
  });
}

const BOOK_LEGITIMATE = [
  ['Wright (treatise)',   'Charles Alan Wright, Federal Practice and Procedure § 1357 (3d ed. 2004)'],
  ['Smith (single)',      'John Smith, A Treatise on Contracts § 1 (2020)'],
  ['Cunningham',          'Cunningham, Securities Litigation Treatise § 12.04 (2d ed. 2022)'],
  ['Two-author Wright',   '11A Charles Alan Wright, Arthur R. Miller & Mary Kay Kane, Federal Practice and Procedure § 2948.1 (3d ed. 2013)'],
];

for (const [label, text] of BOOK_LEGITIMATE) {
  test(`Round 26 — legitimate book "${label}" still extracts`, () => {
    const cands = findSecondarySourceCandidates(text);
    const asBook = cands.filter((c) => c.provisional_type === 'book');
    assert.ok(asBook.length >= 1, `"${text}" must still be recognized as a book`);
  });
}

// ---------------------------------------------------------------------------
// (c) End-to-end Chevron integration test
//
// Combines both fixes: the secondary extractor should reject the
// truncated "Council, Inc." fragment outright (belt-and-suspenders),
// AND the orchestrator dedup should drop it if it slipped through.
// Either way, the validator stack should emit exactly ONE R. 3.2(a)
// flag for the Chevron citation, with the FULL case-name preserved
// in suggested_fix.
// ---------------------------------------------------------------------------

test('Round 26 integration — Chevron emits ONE R. 3.2(a) with full case name', () => {
  const text =
    'Third, the deferential standard applies. Chevron U.S.A., Inc. v. ' +
    'Nat. Res. Def. Council, Inc., 467 U.S. 837, 842-43 (1984). Agency ' +
    'interpretations receive deference.';

  const caseCands = dropContainedDuplicates(findCitationCandidates(text));
  const secCands = findSecondarySourceCandidates(text);

  // Belt-and-suspenders: secondary extractor should reject the truncated
  // "Council, Inc." candidate at source.
  const truncatedBook = secCands.find((c) => /^Council, Inc\./.test(c.candidate_text));
  assert.equal(truncatedBook, undefined, 'Belt-and-suspenders: corporate-suffix exclusion drops "Council, Inc." book candidate');

  // Even if it slipped through, orchestrator dedup would drop it.
  const dedup = filterCrossExtractorOverlap({
    caseCands,
    foreignCands: [],
    officialCands: [],
    secondaryCands: secCands,
  });

  // Run validators on the SURVIVING candidates and count R. 3.2(a) emissions.
  const allCandidates = [
    ...dedup.caseCands.map((c) => ({ ...c, citation_type: c.provisional_type })),
    ...dedup.secondaryCands.map((c) => ({ ...c, citation_type: c.provisional_type })),
  ];
  const r32 = [];
  for (const c of allCandidates) {
    const flags = runAllValidators(c);
    for (const f of flags) {
      if (f.rule_cite === 'BB R. 3.2(a)') {
        r32.push({ candidate_text: c.candidate_text, fix: f.suggested_fix });
      }
    }
  }

  assert.equal(r32.length, 1, `Exactly ONE R. 3.2(a) emission expected; got ${r32.length}`);
  assert.match(
    r32[0].fix,
    /Chevron U\.S\.A\., Inc\. v\. Nat\. Res\. Def\. Council, Inc\., 467 U\.S\. 837, 842–43 \(1984\)/,
    `Suggested fix must preserve the full case name; got: ${r32[0].fix}`
  );
});
