/**
 * Skinner / Murphy regression — guards against the failure modes the
 * user identified in Round 6 review:
 *   1. Citation-extraction regex requiring ≥1 period in the reporter
 *      (would silently drop "562 US 521" so the v.-period and U.S.-period
 *      checks never run on Skinner).
 *   2. Italics-aware case-name detector failing on "v" without a period.
 *   3. vs.→v. trigger too tight — Murphy slipping through.
 *
 * Each test pins one of those failure modes so it can't reappear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';
import { validateCitationForm } from '../validators.js';

test('Skinner v Switzer, 562 US 521 — Pass 1 extracts the citation', () => {
  const text = 'See Skinner v Switzer, 562 US 521, 530 (2011).';
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  assert.equal(cands.length, 1, 'should detect exactly one candidate');
  assert.equal(cands[0].provisional_type, 'case');
  assert.match(cands[0].candidate_text, /Skinner v Switzer/);
  assert.match(cands[0].candidate_text, /562 US 521/);
});

test('Skinner — Pass 3 fires BOTH form flags (v-period AND U.S. periods)', () => {
  const candidate = 'Skinner v Switzer, 562 US 521, 530 (2011)';
  const flags = validateCitationForm(candidate);
  // 1 — case-name "v" without period
  assert.ok(
    flags.some((f) => f.rule_cite === 'BB R. 10.2.1' && /v.*must be followed by a period/i.test(f.message)),
    'expected v-period flag (R. 10.2.1)'
  );
  // 2 — reporter "U.S." periods
  assert.ok(
    flags.some((f) => f.rule_cite === 'BB R. 6.1' && /U\.S\..*periods/i.test(f.message)),
    'expected U.S. periods flag (R. 6.1)'
  );
});

test('Murphy vs. Smith — Pass 1 extracts the citation', () => {
  const text = 'Cf. Murphy vs. Smith, 583 U.S. 220, 226 (2018).';
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  assert.equal(cands.length, 1);
  assert.match(cands[0].candidate_text, /Murphy vs\. Smith/);
});

test('Murphy — Pass 3 fires the vs.→v. flag', () => {
  const candidate = 'Murphy vs. Smith, 583 U.S. 220, 226 (2018)';
  const flags = validateCitationForm(candidate);
  // The validator's message is: 'Use "v." (not "vs." / "vs") between party names.'
  assert.ok(
    flags.some((f) => f.rule_cite === 'BB R. 10.2.1' && /vs/i.test(f.message)),
    `expected vs.→v. flag (R. 10.2.1). Got: ${JSON.stringify(flags)}`
  );
});

test('Skinner / Murphy — running BOTH through the full Pass 1 pipeline together captures both', () => {
  const text =
    'Some preceding sentence. See Skinner v Switzer, 562 US 521, 530 (2011). ' +
    'Another sentence. Cf. Murphy vs. Smith, 583 U.S. 220, 226 (2018).';
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  assert.ok(cands.find((c) => /Skinner/.test(c.candidate_text)), 'Skinner candidate must be present');
  assert.ok(cands.find((c) => /Murphy/.test(c.candidate_text)), 'Murphy candidate must be present');
});
