/**
 * Citation Verifier — Pass 3 validator tests.
 *
 * Run from site/ with:
 *   node --test netlify/lib/citation-verifier/__tests__/validators.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCaseAbbreviations,
  validateReporterCurrency,
  validateCourtParenthetical,
  validateGeographicalAbbreviations,
  validatePeriodicalAbbreviation,
  runAllValidators,
} from '../validators.js';

// ---------------------------------------------------------------------------
// validateCaseAbbreviations (T6)
// ---------------------------------------------------------------------------

test('flags unabbreviated "Education" in second-position word as advisory', () => {
  // "Brown v. Board of Education" — "Education" is not the first word of
  // either party, so per R. 10.2.1(c) it must be abbreviated.
  // Round 6: T6 word abbreviations are advisory (review severity), not
  // hard errors — many federal practitioners spell out T6 words without
  // consequence. The flag still fires; severity is 'review'.
  const flags = validateCaseAbbreviations('Brown v. Board of Education');
  const hit = flags.find((f) => f.message.includes('Education'));
  assert.ok(hit, 'should flag Education');
  assert.equal(hit.severity, 'review');
  assert.equal(hit.table_cite, 'T6');
  assert.match(hit.suggested_fix, /Educ\./);
});

test('flags unabbreviated "Corporation"', () => {
  const flags = validateCaseAbbreviations('Smith v. Acme Corporation');
  const hit = flags.find((f) => f.message.includes('Corporation'));
  assert.ok(hit);
  assert.match(hit.suggested_fix, /Corp\./);
});

test('does NOT flag the FIRST word of a party (R. 10.2.1(c))', () => {
  // "Educational Testing Serv." — "Educational" is the first word of the
  // plaintiff's name, so it should NOT be abbreviated.
  const flags = validateCaseAbbreviations('Education v. Smith');
  // "Education" here is the first word of the plaintiff → no flag.
  const hit = flags.find((f) => f.message.includes('Education'));
  assert.equal(hit, undefined, 'first-word abbreviation must not be flagged');
});

test('handles plurals via singular-stem lookup', () => {
  // "Industries" → from "Industry" → "Indus."
  const flags = validateCaseAbbreviations('Smith v. Acme Industries');
  const hit = flags.find((f) => f.message.includes('Industries'));
  assert.ok(hit);
  assert.match(hit.suggested_fix, /Indus/);
});

test('does NOT flag a correctly-abbreviated word', () => {
  const flags = validateCaseAbbreviations('Smith v. Acme Corp.');
  // "Corp." is already correct.
  assert.equal(flags.length, 0);
});

// ---------------------------------------------------------------------------
// validateReporterCurrency
// ---------------------------------------------------------------------------

test('flags F.3d cited with year after 2021', () => {
  // F.3d ended 2021; F.4th took over.
  const flags = validateReporterCurrency('F.3d', 2022);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'non_conforming');
  assert.match(flags[0].message, /2021/);
});

test('does not flag F.3d cited within range', () => {
  const flags = validateReporterCurrency('F.3d', 2015);
  assert.equal(flags.length, 0);
});

test('flags F.4th cited before its start year', () => {
  const flags = validateReporterCurrency('F.4th', 2018);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'non_conforming');
  assert.match(flags[0].message, /2021/);
});

test('unknown reporter is silent (no false-flag noise)', () => {
  // Per Round 4.7 noise-reduction: validateReporterCurrency no longer
  // flags reporters it doesn't recognize. The Bluebook table coverage
  // is incomplete and flagging "please verify" on every legitimate
  // English/foreign/state-trial reporter the table doesn't have was
  // drowning out real findings. Pass 4 still has visibility to call
  // out genuinely malformed reporters.
  const flags = validateReporterCurrency('Made-Up Rep.', 2020);
  assert.equal(flags.length, 0);
});

test('returns no flag when year is missing', () => {
  assert.deepEqual(validateReporterCurrency('F.3d', null), []);
  assert.deepEqual(validateReporterCurrency('F.3d', undefined), []);
});

// ---------------------------------------------------------------------------
// validateCourtParenthetical
// ---------------------------------------------------------------------------

test('flags missing parenthetical for F.3d citation', () => {
  const flags = validateCourtParenthetical('F.3d', null);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'non_conforming');
  assert.match(flags[0].message, /requires a court parenthetical/);
});

test('flags "2nd Cir." (should be "2d Cir.")', () => {
  const flags = validateCourtParenthetical('F.3d', '2nd Cir. 2019');
  const hit = flags.find((f) => f.message.includes('2nd Cir.'));
  assert.ok(hit);
  assert.equal(hit.severity, 'non_conforming');
  assert.match(hit.suggested_fix, /2d Cir\./);
});

test('flags "DC Cir." (should be "D.C. Cir.")', () => {
  const flags = validateCourtParenthetical('F.3d', 'DC Cir. 2010');
  const hit = flags.find((f) => f.message.includes('DC Cir.'));
  assert.ok(hit);
  assert.match(hit.suggested_fix, /D\.C\. Cir\./);
});

test('does not flag valid 2d Cir. parenthetical', () => {
  const flags = validateCourtParenthetical('F.3d', '2d Cir. 2019');
  assert.equal(flags.length, 0);
});

test('flags missing parenthetical for F. Supp. 3d', () => {
  const flags = validateCourtParenthetical('F. Supp. 3d', null);
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /district-court parenthetical/);
});

test('U.S. citation does not require court parenthetical', () => {
  const flags = validateCourtParenthetical('U.S.', null);
  assert.equal(flags.length, 0);
});

// ---------------------------------------------------------------------------
// validateGeographicalAbbreviations (T10)
// ---------------------------------------------------------------------------

test('flags "Calif." → "Cal."', () => {
  const flags = validateGeographicalAbbreviations('Smith v. Calif. State Univ.');
  const hit = flags.find((f) => f.message.includes('Calif.'));
  assert.ok(hit);
  assert.match(hit.suggested_fix, /Cal\./);
});

test('flags "Penn." → "Pa."', () => {
  const flags = validateGeographicalAbbreviations('100 Penn. Stat. § 5');
  const hit = flags.find((f) => f.message.includes('Penn.'));
  assert.ok(hit);
});

test('does not false-match "Cal." inside "California"', () => {
  // T10 has "Calif." → "Cal.", but "California" should not match — the
  // word-boundary lookahead in the validator must guard against this.
  const flags = validateGeographicalAbbreviations('Smith v. California Bar');
  // "California" should NOT trigger the misuse rule.
  const hit = flags.find((f) => f.message.includes('Calif.'));
  assert.equal(hit, undefined);
});

// ---------------------------------------------------------------------------
// validatePeriodicalAbbreviation (T13)
// ---------------------------------------------------------------------------

test('flags long-form "Harvard Law Review" with abbreviation suggestion', () => {
  const flags = validatePeriodicalAbbreviation('Harvard Law Review');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'non_conforming');
  assert.equal(flags[0].suggested_fix, 'Harv. L. Rev.');
});

test('canonical "Harv. L. Rev." passes silently', () => {
  const flags = validatePeriodicalAbbreviation('Harv. L. Rev.');
  assert.equal(flags.length, 0);
});

test('unknown periodical → review-level flag', () => {
  const flags = validatePeriodicalAbbreviation('Tiny Local Bar Bulletin');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'review');
});

// ---------------------------------------------------------------------------
// runAllValidators (orchestrator)
// ---------------------------------------------------------------------------

test('runAllValidators on a clean citation returns no flags', () => {
  const citation = {
    citation_type: 'case',
    candidate_text: 'Smith v. Acme Corp., 100 F.3d 200 (2d Cir. 2015)',
    components: {
      case_name: 'Smith v. Acme Corp.',
      reporter: 'F.3d',
      year: 2015,
      court_parenthetical: '2d Cir. 2015',
    },
  };
  const flags = runAllValidators(citation);
  assert.equal(flags.length, 0, `expected zero flags, got: ${JSON.stringify(flags, null, 2)}`);
});

test('runAllValidators stacks flags from multiple validators', () => {
  // Bad case-name word AND wrong court abbrev AND post-end-of-reporter year.
  const citation = {
    citation_type: 'case',
    candidate_text: 'Smith v. Acme Corporation, 100 F.3d 200 (2nd Cir. 2022)',
    components: {
      case_name: 'Smith v. Acme Corporation',
      reporter: 'F.3d',
      year: 2022,
      court_parenthetical: '2nd Cir. 2022',
    },
  };
  const flags = runAllValidators(citation);
  // Expect: T6 (Corporation→Corp.), reporter-currency (F.3d ended 2021),
  // T7 (2nd Cir. → 2d Cir.). At minimum 3 flags.
  assert.ok(flags.length >= 3, `expected ≥3 flags, got ${flags.length}: ${JSON.stringify(flags)}`);
});
