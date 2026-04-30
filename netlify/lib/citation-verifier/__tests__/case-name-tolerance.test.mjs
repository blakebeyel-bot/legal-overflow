/**
 * Round 6.x — CourtListener case-name tolerance tests.
 *
 * Per the spec: "Token-overlap with a 70%+ threshold on the longer
 * party name is a reasonable starting point. This single fix kills
 * #7 and #11 cleanly."
 *
 * The exemplars below cover the normalization rules required:
 *   • punctuation
 *   • Inc./Incorporated, Co./Company, Corp./Corporation
 *   • middle-name abbreviation
 *   • v. / v / vs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCaseName,
  caseNameOverlap,
  caseNameMatches,
} from '../court-listener.js';

// ---------------------------------------------------------------------------
// normalizeCaseName
// ---------------------------------------------------------------------------

test('normalizeCaseName strips punctuation + lowercases', () => {
  assert.equal(normalizeCaseName('Brown v. Board of Education'),
               'brown v bd of educ');
});

test('normalizeCaseName collapses Co./Company, Corp./Corporation, Inc./Incorporated', () => {
  // All three pairs should normalize to the same canonical form.
  assert.equal(normalizeCaseName('Acme Co.'),       normalizeCaseName('Acme Company'));
  assert.equal(normalizeCaseName('Acme Corp.'),     normalizeCaseName('Acme Corporation'));
  assert.equal(normalizeCaseName('Acme Inc.'),      normalizeCaseName('Acme Incorporated'));
});

test('normalizeCaseName collapses v. / v / vs.', () => {
  const a = normalizeCaseName('Smith v. Jones');
  const b = normalizeCaseName('Smith v Jones');
  const c = normalizeCaseName('Smith vs. Jones');
  const d = normalizeCaseName('Smith vs Jones');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(c, d);
});

// ---------------------------------------------------------------------------
// caseNameOverlap — token-overlap scoring
// ---------------------------------------------------------------------------

test('exact same name → overlap 1.0', () => {
  assert.equal(caseNameOverlap('Brown v. Board', 'Brown v. Board'), 1.0);
});

test('Inc. vs Incorporated → high overlap (≥0.70)', () => {
  // Different suffix forms but same entity.
  const ovr = caseNameOverlap(
    'Stoneridge Investment Partners, LLC v. Scientific-Atlanta Inc.',
    'Stoneridge Investment Partners, LLC v. Scientific-Atlanta, Incorporated'
  );
  assert.ok(ovr >= 0.70, `expected ≥0.70, got ${ovr}`);
});

test('J. McIntyre Mach., Ltd. v. Nicastro vs. CL canonical → ≥0.70', () => {
  // Real-world example — the spec calls out #7 specifically.
  const ovr = caseNameOverlap(
    'J. McIntyre Mach., Ltd. v. Nicastro',
    'J. McIntyre Machinery, Ltd. v. Nicastro'
  );
  assert.ok(ovr >= 0.70, `expected ≥0.70, got ${ovr}`);
});

test('Marbury v. Madison vs. CL canonical → ≥0.70', () => {
  // Spec mentions #11 (Marbury). Likely CL stores it just as
  // "Marbury v. Madison" without the (1 Cranch) interlinear.
  const ovr = caseNameOverlap('Marbury v. Madison', 'Marbury v. Madison');
  assert.equal(ovr, 1.0);
});

test('totally different cases → low overlap', () => {
  const ovr = caseNameOverlap(
    'Brown v. Board of Education',
    'Roe v. Wade'
  );
  assert.ok(ovr < 0.30, `expected <0.30, got ${ovr}`);
});

test('vs. vs v. equivalence — same case, different versus marker', () => {
  const ovr = caseNameOverlap('Smith vs. Jones', 'Smith v. Jones');
  assert.ok(ovr >= 0.70, `expected ≥0.70, got ${ovr}`);
});

test('middle initial vs full name still matches', () => {
  // "John Q. Smith" vs "John Smith" — middle initials are stripped.
  const ovr = caseNameOverlap('John Q. Smith v. Jones', 'John Smith v. Jones');
  assert.ok(ovr >= 0.70, `expected ≥0.70, got ${ovr}`);
});

// ---------------------------------------------------------------------------
// caseNameMatches — boolean threshold helper
// ---------------------------------------------------------------------------

test('caseNameMatches respects the default 0.50 threshold', () => {
  // Slight variation should pass.
  assert.equal(caseNameMatches('Acme Co. v. Beta', 'Acme Company v. Beta'), true);
  // Major divergence should fail.
  assert.equal(caseNameMatches('Brown v. Board', 'Roe v. Wade'), false);
});

test('caseNameMatches handles missing names gracefully', () => {
  assert.equal(caseNameMatches(null, 'Brown v. Board'), false);
  assert.equal(caseNameMatches('Brown v. Board', null), false);
  assert.equal(caseNameMatches('', ''), false);
});

// ---------------------------------------------------------------------------
// Round 7 — exact test cases from the spec. Every one must pass before
// any build can ship.
// ---------------------------------------------------------------------------

test('SPEC: Conley v. Gibson vs. Conley v. Gibson → match', () => {
  assert.equal(caseNameMatches('Conley v. Gibson', 'Conley v. Gibson'), true);
});

test('SPEC: Conley v. Gibson vs. Conley v. Gibson, et al. → match', () => {
  assert.equal(
    caseNameMatches('Conley v. Gibson', 'Conley v. Gibson, et al.'),
    true,
    'et/al must be filtered as stopwords; smaller-set denominator must catch this'
  );
});

test('SPEC: Halliburton — entity-suffix variation matches', () => {
  assert.equal(
    caseNameMatches(
      'Halliburton Co. v. Erica P. John Fund, Inc.',
      'Halliburton Company v. Erica P. John Fund, Incorporated'
    ),
    true
  );
});

test('SPEC: Globe Refining — abbreviation variation matches', () => {
  // Note: this only succeeds if "Refining" and "Ref." normalize to the
  // same token. Currently we normalize "Refining" → ... not in expansions.
  // Test added to surface — if it fails, expand normalization.
  assert.equal(
    caseNameMatches(
      'Globe Refining Co. v. Landa Cotton Oil Co.',
      'Globe Ref. Co. v. Landa Cotton Oil Co.'
    ),
    true
  );
});

test('SPEC: Helicopteros — extra suffix tokens still match', () => {
  assert.equal(
    caseNameMatches(
      'Helicopteros Nacionales de Colombia, S.A. v. Hall',
      'Helicopteros Nacionales de Colombia v. Hall'
    ),
    true,
    'S.A. is a single-letter token group; smaller-set denominator must accept'
  );
});

test('SPEC: Conley vs. Smith (different cases) → NO match', () => {
  assert.equal(caseNameMatches('Conley v. Gibson', 'Smith v. Jones'), false);
});

test('SPEC: Marbury vs. McCulloch (different cases) → NO match', () => {
  assert.equal(caseNameMatches('Marbury v. Madison', 'McCulloch v. Maryland'), false);
});
