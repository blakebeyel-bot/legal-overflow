/**
 * Round 30 — short-form citation gating across all validators.
 *
 * Three validators were misfiring on short-form case citations,
 * masked previously by ¶¶ paragraph-range comment volume:
 *
 *   1. T6 (R. 10.2.2) abbreviation validator — fired on
 *      "Goldman Sachs, 594 U.S. at 124" with suggested fixes against
 *      the antecedent's full case name. T6 applies to FULL case names
 *      only.
 *   2. R. 10.4 court-parenthetical validator — fired on Vivendi /
 *      Press / DDAVP / Salomon short forms. Existing gate checked
 *      provisional_type, but classify-citation.js wasn't propagating
 *      it; gate also failed when LLM misclassified short forms as
 *      'case' (notably "See Anderson, ..." with leading signal).
 *   3. CourtListener verification — fired on Tellabs / Anderson short
 *      forms, wasting API calls and emitting UNRESOLVED comments. The
 *      full citation already verified the case.
 *
 * Audit table per user spec:
 *
 *   Validator                       | Fires on short forms?
 *   ────────────────────────────────|──────────────────────
 *   R. 3.2(a) pin-range hyphen      | YES
 *   R. 4.1 Id. validity             | YES
 *   R. 10.2.2 T6 abbreviations      | NO  ← gated this round
 *   R. 10.4 court parenthetical     | NO  ← gate hardened this round
 *   R. 10.5 court paren comma       | YES
 *   R. 10.9 gap detection           | YES
 *   CourtListener verification      | NO  ← gated this round
 *
 * Architectural fix: isShortFormCaseCitation(c) helper is the single
 * source of truth, checking citation_type, provisional_type, AND
 * pattern_name (defense in depth against Pass 2 misclassification).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAllValidators, isShortFormCaseCitation } from '../validators.js';
import { CourtListenerClient } from '../court-listener.js';

// ---------------------------------------------------------------------------
// (a) isShortFormCaseCitation helper
// ---------------------------------------------------------------------------

test('Round 30 — isShortFormCaseCitation true when citation_type is short_form_case', () => {
  assert.equal(isShortFormCaseCitation({ citation_type: 'short_form_case' }), true);
});

test('Round 30 — isShortFormCaseCitation true when provisional_type is short_form_case (LLM misclass)', () => {
  // Pass 2 returned 'case' but Pass 1 had identified it as short_form_case
  assert.equal(
    isShortFormCaseCitation({ citation_type: 'case', provisional_type: 'short_form_case' }),
    true
  );
});

test('Round 30 — isShortFormCaseCitation true when pattern_name is short_case (deepest fallback)', () => {
  // Both Pass 2 and provisional_type lost the short-form signal somehow,
  // but Pass 1's pattern_name is deterministic from the regex match.
  assert.equal(
    isShortFormCaseCitation({ citation_type: 'case', pattern_name: 'short_case' }),
    true
  );
});

test('Round 30 — isShortFormCaseCitation false on regular case citations', () => {
  assert.equal(
    isShortFormCaseCitation({ citation_type: 'case', pattern_name: 'reporter', provisional_type: 'case' }),
    false
  );
});

test('Round 30 — isShortFormCaseCitation false on non-cases', () => {
  assert.equal(isShortFormCaseCitation({ citation_type: 'statute' }), false);
  assert.equal(isShortFormCaseCitation({ citation_type: 'short_form_id' }), false);
  assert.equal(isShortFormCaseCitation({}), false);
  assert.equal(isShortFormCaseCitation(null), false);
});

// ---------------------------------------------------------------------------
// (b) T6 (R. 10.2.2) — must NOT fire on short forms
// ---------------------------------------------------------------------------

test('Round 30 Bug T6 — T6 does NOT fire on short_form_case', () => {
  const c = {
    citation_type: 'short_form_case',
    candidate_text: 'Goldman Sachs, 594 U.S. at 124',
    components: {
      case_name: 'Goldman Sachs Group, Inc. v. Arkansas Teacher Retirement System',
      reporter: 'U.S.',
    },
  };
  const flags = runAllValidators(c);
  const t6 = flags.filter((f) => f.rule_cite === 'BB R. 10.2.2');
  assert.equal(t6.length, 0, 'T6 must not fire on short form');
});

test('Round 30 Bug T6 — T6 does NOT fire when LLM misclassifies short form as case', () => {
  // Pass 2 mis-tagged this as 'case' but Pass 1 knows it's a short form.
  const c = {
    citation_type: 'case',
    provisional_type: 'short_form_case',
    pattern_name: 'short_case',
    candidate_text: 'Goldman Sachs, 594 U.S. at 124',
    components: {
      case_name: 'Goldman Sachs Group, Inc. v. Arkansas Teacher Retirement System',
      reporter: 'U.S.',
    },
  };
  const flags = runAllValidators(c);
  const t6 = flags.filter((f) => f.rule_cite === 'BB R. 10.2.2');
  assert.equal(t6.length, 0, 'T6 gate must catch misclassified short forms via pattern_name');
});

test('Round 30 Bug T6 — T6 STILL fires on full-form case (no regression)', () => {
  const c = {
    citation_type: 'case',
    pattern_name: 'reporter',
    candidate_text: 'Goldman Sachs Group, Inc. v. Arkansas Teacher Retirement System, 594 U.S. 113, 121 (2021)',
    components: {
      case_name: 'Goldman Sachs Group, Inc. v. Arkansas Teacher Retirement System',
      reporter: 'U.S.',
    },
  };
  const flags = runAllValidators(c);
  const t6 = flags.filter((f) => f.rule_cite === 'BB R. 10.2.2');
  assert.ok(t6.length >= 3, `Full form must still fire T6 catches; got ${t6.length}`);
});

// ---------------------------------------------------------------------------
// (c) R. 10.4 court parenthetical — must NOT fire on short forms
// ---------------------------------------------------------------------------

test('Round 30 Bug R. 10.4 — does NOT fire on short_form_case', () => {
  const c = {
    citation_type: 'short_form_case',
    candidate_text: 'Vivendi, 838 F.3d at 247',
    components: { reporter: 'F.3d', court_parenthetical: null },
  };
  const flags = runAllValidators(c);
  const r104 = flags.filter((f) => f.rule_cite === 'BB R. 10.4');
  assert.equal(r104.length, 0, 'R. 10.4 must not fire on short form');
});

test('Round 30 Bug R. 10.4 — does NOT fire when LLM misclassifies short form (Pass 1 fallback)', () => {
  const c = {
    citation_type: 'case',
    provisional_type: 'short_form_case',
    pattern_name: 'short_case',
    candidate_text: 'See Anderson, 477 U.S. at 248',
    components: { reporter: 'U.S.', court_parenthetical: null },
  };
  const flags = runAllValidators(c);
  const r104 = flags.filter((f) => f.rule_cite === 'BB R. 10.4');
  assert.equal(r104.length, 0, 'Pass 1 short_case fallback must catch the misclassification');
});

test('Round 30 Bug R. 10.4 — STILL fires on full-form F.3d missing court paren (no regression)', () => {
  const c = {
    citation_type: 'case',
    pattern_name: 'reporter',
    candidate_text: 'Smith v. Jones, 99 F.3d 1',
    components: { reporter: 'F.3d', court_parenthetical: null },
  };
  const flags = runAllValidators(c);
  const r104 = flags.find((f) => f.rule_cite === 'BB R. 10.4');
  assert.ok(r104, 'Full-form F.3d without court paren must still fire R. 10.4');
});

// ---------------------------------------------------------------------------
// (d) CourtListener — skips short forms
// ---------------------------------------------------------------------------

test('Round 30 Bug CL — checkExistence returns not_applicable for short_form_case', async () => {
  const cl = new CourtListenerClient();
  const result = await cl.checkExistence({
    citation_type: 'short_form_case',
    candidate_text: 'Tellabs, 551 U.S. at 322',
    components: { volume: 551, reporter: 'U.S.', first_page: 308 },
  });
  assert.equal(result.status, 'not_applicable');
});

test('Round 30 Bug CL — short-form fallback via pattern_name even when LLM says case', async () => {
  const cl = new CourtListenerClient();
  const result = await cl.checkExistence({
    citation_type: 'case',
    pattern_name: 'short_case',
    provisional_type: 'short_form_case',
    candidate_text: 'See Anderson, 477 U.S. at 248',
    components: { volume: 477, reporter: 'U.S.', first_page: 242 },
  });
  assert.equal(result.status, 'not_applicable');
  assert.equal(result._silent_reason, 'short_form_case');
});

// ---------------------------------------------------------------------------
// (e) Validators that SHOULD still fire on short forms
// ---------------------------------------------------------------------------

test('Round 30 audit — R. 3.2(a) pin range FIRES on short form', () => {
  const c = {
    citation_type: 'short_form_case',
    candidate_text: 'Anderson, 477 U.S. at 248-49',
    components: { reporter: 'U.S.' },
  };
  const flags = runAllValidators(c);
  const r32 = flags.filter((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.ok(r32.length >= 1, 'R. 3.2(a) must still fire on short-form pin ranges');
});

test('Round 30 audit — R. 10.5 stray comma FIRES on short form with court paren', () => {
  const c = {
    citation_type: 'short_form_case',
    candidate_text: 'Smith, 99 So. 3d at 5 (Fla. 4th DCA, 2021)',
    components: { reporter: 'So. 3d' },
  };
  const flags = runAllValidators(c);
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5');
  assert.ok(r105, 'R. 10.5 stray-comma catch must still fire on short forms');
});

// ---------------------------------------------------------------------------
// (f) Defense-in-depth: full-case CL still works when no short-form signal
// ---------------------------------------------------------------------------

test('Round 30 — checkExistence still runs on a full case citation', async () => {
  const cl = new CourtListenerClient({ fetchImpl: async () => ({
    ok: false,
    status: 500,
  }) });
  const result = await cl.checkExistence({
    citation_type: 'case',
    pattern_name: 'reporter',
    provisional_type: 'case',
    candidate_text: 'Bell Atl. Corp. v. Twombly, 550 U.S. 544 (2007)',
    components: { volume: 550, reporter: 'U.S.', first_page: 544 },
  });
  // Full case → CL ran (got an api_error from our mock 500), not skipped
  // for short-form reasons.
  assert.notEqual(result._silent_reason, 'short_form_case');
});
