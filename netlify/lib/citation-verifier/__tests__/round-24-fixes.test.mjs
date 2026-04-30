/**
 * Round 24 — fixes for Round 23's regex changes that didn't actually fire
 * in production because Pass 1 extractors were truncating candidates
 * BEFORE the validator regex saw them.
 *
 * Bug A diagnosis (per user's diagnostic ladder):
 *   The unit-level R. 3.2(a) regex worked. But:
 *   • REPORTER_PATTERN page-pin character class only accepted [-,] + en
 *     dash; em dash (U+2014) was NOT in the set. Result: candidate text
 *     for "424 U.S. 319, 333—35" terminated at "333" because the regex's
 *     comma-or-dash repeat group failed at the em dash.
 *   • ID_PATTERN's pin range had the same issue — "Id. at 49—50" was
 *     truncated to "Id. at 49".
 *   • ¶¶ paragraph ranges weren't extracted at all (no extractor pattern).
 *
 * This file is the integration test the user requested. It runs the FULL
 * extraction → validators chain and confirms each of the three patterns
 * fires end-to-end. Round 23's unit tests passed against raw text; these
 * tests pass against extracted candidates.
 *
 * Bug C: First-word T6 skip blocked entity-prefix abbreviations (Department,
 * Bureau, Commission, Authority, etc.) — these are universally abbreviated
 * even at the start of a party's name per Bluebook practice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findCitationCandidates } from '../citation-patterns.js';
import { runAllValidators, validateCaseAbbreviations } from '../validators.js';
import { scanDocumentIssues } from '../scan-document-issues.js';

// --- Bug A integration: end-to-end em-dash + paragraph-range ----------

test('Bug A integration — Mathews em-dash pin range fires R. 3.2(a)', () => {
  const text = 'See Mathews v. Eldridge, 424 U.S. 319, 333—35 (1976).';
  const cands = findCitationCandidates(text);
  const cand = cands.find((c) => c.provisional_type === 'case');
  assert.ok(cand, 'Mathews must extract as case candidate');
  // The candidate must include the em dash.
  assert.match(cand.candidate_text, /333—35/, `candidate must include em dash; got: ${cand.candidate_text}`);
  // Run full validators.
  cand.citation_type = 'case';
  cand.components = { reporter: 'U.S.', year: 1976, court_parenthetical: '1976' };
  const flags = runAllValidators(cand);
  const r32 = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.ok(r32, 'R. 3.2(a) must fire on em-dash pin');
  assert.match(r32.message, /em dash/);
});

test('Bug A integration — Id. em-dash pin range fires R. 3.2(a)', () => {
  const text = 'See Iqbal at 678. Id. at 49—50.';
  const cands = findCitationCandidates(text);
  const idCand = cands.find((c) => c.provisional_type === 'short_form_id' && c.candidate_text.includes('49'));
  assert.ok(idCand, 'Id. must extract');
  assert.match(idCand.candidate_text, /49—50/);
  idCand.citation_type = 'short_form_id';
  const flags = runAllValidators(idCand);
  const r32 = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.ok(r32, 'R. 3.2(a) must fire on Id. em-dash pin');
});

test('Bug A integration — ¶¶ paragraph range fires R. 3.2(a) via scan-document-issues', () => {
  const text = 'See Compl. ¶¶ 31-38. The defendant disputes...';
  const cands = scanDocumentIssues(text);
  const para = cands.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 3.2(a)' && /Paragraph/.test(c.flags[0].message));
  assert.ok(para, 'paragraph-range catch must fire as document issue');
  assert.match(para.candidate_text, /¶¶ 31-38/);
  assert.match(para.flags[0].suggested_fix, /¶¶ 31–38/);
});

test('Bug A integration — ¶¶ em-dash range also fires', () => {
  const text = 'Compl. ¶¶ 12—18.';
  const cands = scanDocumentIssues(text);
  const para = cands.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 3.2(a)');
  assert.ok(para);
  assert.match(para.flags[0].message, /em dash/);
});

// --- Bug C: first-word T6 fires for entity-prefix words ----------------

test('Bug C — Department of Homeland Security flags BOTH Department and Security', () => {
  const flags = validateCaseAbbreviations(
    'Department of Homeland Security v. Regents of the Univ. of California',
    'Department of Homeland Security v. Regents of the Univ. of California, 591 U.S. 1 (2020)'
  );
  const dep = flags.find((f) => /Department/.test(f.message));
  const sec = flags.find((f) => /Security/.test(f.message));
  assert.ok(dep, 'Department→Dep\'t must fire even as first word of party');
  assert.ok(sec, 'Security→Sec. still fires');
});

test('Bug C — first-word "International" still NOT flagged (preserves Acme control)', () => {
  // International Shoe Co. v. Washington — Acme has this as a control.
  // "International" should remain skipped (not an entity-prefix word).
  const flags = validateCaseAbbreviations(
    'International Shoe Co. v. Washington',
    'See International Shoe Co. v. Washington, 326 U.S. 310 (1945)'
  );
  const intl = flags.find((f) => /International/.test(f.message));
  assert.equal(intl, undefined, 'International first-word must remain skipped');
});

test('Bug C — first-word "Commission" fires for entity-prefix abbreviation', () => {
  const flags = validateCaseAbbreviations(
    'Commission on Civil Rights v. Smith',
    'Commission on Civil Rights v. Smith, 100 U.S. 1 (2020)'
  );
  const commission = flags.find((f) => /Commission/.test(f.message));
  assert.ok(commission, 'Commission→Comm\'n must fire even as first word of party');
});
