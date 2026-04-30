/**
 * Round 23 — Kaufman patent brief surfaced two bug classes.
 *
 * Bug A: validateCourtParenthetical (R. 10.4 / T7) firing on short-form
 *   case citations. Short forms inherit the court designator from their
 *   full-cite antecedent per R. 10.9; the parenthetical is not repeated.
 *   Fix: gate the validator on citation_type !== 'short_form_case'.
 *
 * Bug B: validateCitationForm (R. 3.2(a)) only flagged ASCII-hyphen pin
 *   ranges in full-form case citations. It missed:
 *     (1) em dashes (U+2014) — Word auto-correct produces "—" from "--";
 *         Bluebook still requires en dash (U+2013).
 *     (2) Id. short-form pin ranges "id. at N-M".
 *     (3) Paragraph-range record citations "¶¶ N-M".
 *   Fix: extend the validator with three additional patterns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runAllValidators,
  validateCitationForm,
  validateCourtParenthetical,
} from '../validators.js';

// --- Bug A: short-form case shouldn't require court parenthetical ---------

test('Bug A — short_form_case does NOT fire R. 10.4 missing-parenthetical', () => {
  const flags = runAllValidators({
    citation_type: 'short_form_case',
    candidate_text: 'Bosch, 659 F.3d at 1153',
    components: { reporter: 'F.3d', court_parenthetical: null },
    pre_context: '',
    post_context: '',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.4');
  assert.equal(hit, undefined, `short form should not require court paren; got: ${hit?.message}`);
});

test('Bug A — full case STILL fires R. 10.4 when missing parenthetical', () => {
  // Sanity: the validator must still fire on full-form cases that lack the
  // required circuit-court parenthetical.
  const flags = validateCourtParenthetical('F.3d', null);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.4');
  assert.ok(hit, 'full F.3d cite without parenthetical should still flag');
});

test('Bug A — Bosch short form with court already in pre_context produces no comment', () => {
  // Realistic Bosch scenario: full cite earlier in document, short form
  // here. The R. 10.4 validator is skipped for short_form_case regardless
  // of whether the full-cite parenthetical is visible.
  const flags = runAllValidators({
    citation_type: 'short_form_case',
    candidate_text: 'See Robert Bosch, 659 F.3d at 1148',
    components: { reporter: 'F.3d', court_parenthetical: null },
    pre_context: 'Robert Bosch LLC v. Pylon Mfg. Corp., 659 F.3d 1142, 1151 (Fed. Cir. 2011). ',
    post_context: '',
  });
  const r104 = flags.find((f) => f.rule_cite === 'BB R. 10.4');
  assert.equal(r104, undefined);
});

// --- Bug B: R. 3.2(a) extended pin-range coverage -------------------------

test('Bug B (em dash) — flags em dash in full-cite pin range', () => {
  // Sanofi-Synthelabo v. Apotex, Inc., 470 F.3d 1368, 1383—84 (Fed. Cir. 2006)
  const text = 'Sanofi-Synthelabo v. Apotex, Inc., 470 F.3d 1368, 1383—84 (Fed. Cir. 2006)';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)' && /em dash/.test(f.message));
  assert.ok(hit, `should flag em dash in pin range; got: ${flags.map((f) => f.rule_cite).join(', ')}`);
  assert.match(hit.suggested_fix, /1383–84/);
});

test('Bug B (em dash) — does NOT flag pin range that already uses en dash', () => {
  const text = 'Smith v. Jones, 100 F.3d 200, 205–06 (2d Cir. 2010)';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(hit, undefined);
});

test('Bug B (id. short form) — flags hyphen in "id. at 740-41"', () => {
  const text = 'See id. at 740-41.';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)' && /Id\. short-form/.test(f.message));
  assert.ok(hit, `should flag id. pin range; got: ${flags.map((f) => f.message).join(' | ')}`);
  assert.match(hit.suggested_fix, /at 740–41/);
});

test('Bug B (id. short form em dash) — flags em dash in "Id. at 100—01"', () => {
  const text = 'Id. at 100—01.';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)' && /em dash/.test(f.message));
  assert.ok(hit);
});

test('Bug B (paragraph range) — flags hyphen in "Compl. ¶¶ 12-18"', () => {
  const text = 'See Compl. ¶¶ 12-18.';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)' && /Paragraph range/.test(f.message));
  assert.ok(hit, `should flag para range; got: ${flags.map((f) => f.message).join(' | ')}`);
  assert.match(hit.suggested_fix, /¶¶ 12–18/);
});

test('Bug B (paragraph range em dash) — flags em dash "Compl. ¶¶ 12—18"', () => {
  const text = 'See Compl. ¶¶ 12—18.';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)' && /em dash/.test(f.message));
  assert.ok(hit);
});

test('Bug B — does NOT flag hyphen inside section numbers (regression check)', () => {
  // From Round 13 / corpus: "17 C.F.R. § 240.10b-5" has a hyphen but it's
  // a section-subdivision marker, not a pin range. The original validator
  // gated on ", " before the digit pair to disambiguate; the extensions
  // must preserve this guard.
  const text = '17 C.F.R. § 240.10b-5 (2024)';
  const flags = validateCitationForm(text);
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(hit, undefined);
});
