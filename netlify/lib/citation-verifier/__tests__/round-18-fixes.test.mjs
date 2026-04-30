/**
 * Round 18 — Brief 7 short-form edge cases.
 *
 *   R. 4.1   — Id. after multi-source string cite (validateIdAfterStringCite)
 *   R. 4.2(a)— supra forbidden for cases (validateSupraForCase) - extended
 *   R. 4.2(b)— supra OK for treatises/articles (FP-resistance)
 *   R. 6.1   — short-form abbreviation periods (Auto/Nat FP fix)
 *
 *   Plus extractor regression tests for SUPRA_PATTERN with co-author "&".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSupraForCase,
  validateIdAfterStringCite,
  validateShortFormAbbreviationPeriods,
} from '../validators.js';
import { findCitationCandidates } from '../citation-patterns.js';

// --- R. 4.1 Id. after multi-source string cite ----------------------------

test('R. 4.1 — flags Id. after string cite with semicolon-separated authorities', () => {
  const flags = validateIdAfterStringCite({
    citation_type: 'short_form_id',
    candidate_text: 'Id. at 1289',
    pre_context: 'See Am. Dental Ass\'n v. Cigna Corp., 605 F.3d 1283, 1289 (11th Cir. 2010); Speaker v. U.S. Dep\'t of Health & Human Servs., 623 F.3d 1371, 1381 (11th Cir. 2010). ',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 4.1');
  assert.ok(hit, 'should flag Id. after multi-source');
  assert.match(hit.message, /string cite/i);
});

test('R. 4.1 — does NOT flag Id. after a single-source citation', () => {
  const flags = validateIdAfterStringCite({
    citation_type: 'short_form_id',
    candidate_text: 'Id.',
    pre_context: 'See Hensley Mfg. v. ProPride, Inc., 579 F.3d 603, 609 (6th Cir. 2009). ',
  });
  assert.equal(flags.length, 0);
});

test('R. 4.1 — does NOT flag Id. when no preceding sentence boundary visible', () => {
  const flags = validateIdAfterStringCite({
    citation_type: 'short_form_id',
    candidate_text: 'Id.',
    pre_context: 'short prefix',
  });
  // No boundary → no preceding citation sentence → cannot determine multi-source
  assert.equal(flags.length, 0);
});

// --- R. 4.2(a) supra-for-cases (extended) ---------------------------------

test('R. 4.2(a) — flags Twombly supra (case)', () => {
  const flags = validateSupraForCase({
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: 'Twombly, supra, at 557',
    pre_context: '',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 4.2');
  assert.ok(hit);
});

test('R. 4.2(a) — does NOT flag treatise supra "5B Wright & Miller, supra"', () => {
  const flags = validateSupraForCase({
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: '5B Wright & Miller, supra, § 1357',
    pre_context: '',
  });
  assert.equal(flags.length, 0);
});

test('R. 4.2(a) — does NOT flag treatise supra "Wright & Miller, supra"', () => {
  const flags = validateSupraForCase({
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: 'Wright & Miller, supra, § 1357, at 712',
    pre_context: '',
  });
  assert.equal(flags.length, 0);
});

test('R. 4.2(a) — does NOT flag cross-reference "supra Part II"', () => {
  const flags = validateSupraForCase({
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: 'supra',
    post_context: ' Part II, the plausibility standard governs.',
    pre_context: 'As discussed above, see ',
  });
  assert.equal(flags.length, 0);
});

test('R. 4.2(a) — strips signal prefix "See" before checking lead-in', () => {
  // "See Burbank, supra" — leadIn is "See Burbank"; signal-strip removes "See"
  // and document_text contains article pattern, so should NOT flag.
  const flags = validateSupraForCase({
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: 'See Burbank, supra, at 115',
    pre_context: '',
    document_text: 'Stephen B. Burbank, Pleading and the Dilemmas of Modern American Procedure, 93 Judicature 109, 112 (2009).',
  });
  assert.equal(flags.length, 0);
});

// --- R. 6.1/T6 short-form abbreviation periods FP fix ---------------------

test('R. 6.1/T6 — does NOT flag "Nat\'l" inside "Nat\'l Ass\'n"', () => {
  const flags = validateShortFormAbbreviationPeriods("Mayfield v. Nat'l Ass'n for Stock Car Auto Racing, Inc., 674 F.3d 369");
  const hit = flags.find((f) => /Nat/.test(f.message));
  assert.equal(hit, undefined);
});

test('R. 6.1/T6 — does NOT flag "Auto" followed by "Racing" (real word)', () => {
  const flags = validateShortFormAbbreviationPeriods("Mayfield v. Nat'l Ass'n for Stock Car Auto Racing, Inc., 674 F.3d 369");
  const hit = flags.find((f) => /Auto/.test(f.message));
  assert.equal(hit, undefined);
});

test('R. 6.1/T6 — DOES flag "Bell Atl" missing period', () => {
  const flags = validateShortFormAbbreviationPeriods('Bell Atl, 550 U.S. at 555');
  const hit = flags.find((f) => /Atl/.test(f.message));
  assert.ok(hit);
});

// --- Extractor: SUPRA_PATTERN co-author "&" capture -----------------------

test('SUPRA_PATTERN — captures "5B Wright & Miller, supra"', () => {
  const text = 'See generally 5B Wright & Miller, supra, § 1357.';
  const cands = findCitationCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'short_form_supra');
  assert.ok(hit);
  assert.match(hit.candidate_text, /Wright & Miller, supra/);
});
