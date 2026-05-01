/**
 * Round 27 — adversarial brief fixes.
 *
 * Bug A — R. 10.5 court-paren-comma validator over-fired on slip-opinion
 *         dates: "(D.C. Cir. Mar. 4, 2024)". The comma between Day and
 *         Year is the conventional date format per R. 10.8.1, NOT a
 *         stray comma. Fix: skip the validator when the pre-comma token
 *         ENDS with a month-day pattern.
 *
 * Bug B — Case-name walk-back stopped at "d/b/a" (a lowercase token
 *         between two capitalized parties). Robertson, Inc., d/b/a
 *         Robertson Industries v. Cromwell was truncated to "Robertson
 *         Industries v. Cromwell". Fix: PARTY_INTERNAL_MARKERS set in
 *         refineCaseNameStartFromV walks PAST these tokens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAllValidators } from '../validators.js';
import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';

// ---------------------------------------------------------------------------
// Bug A — R. 10.5 slip-opinion date guard
// ---------------------------------------------------------------------------

test('Round 27 Bug A — (D.C. Cir. Mar. 4, 2024) slip opinion does NOT fire R. 10.5', () => {
  const text = "Anderson v. Federal Trade Comm'n, No. 22-1456, 2024 WL 5673421, at *6 (D.C. Cir. Mar. 4, 2024)";
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5' && /comma before the year/.test(f.message));
  assert.equal(r105, undefined, 'R. 10.5 must not fire on slip-opinion court-date parenthetical');
});

test('Round 27 Bug A — (Fla. 4th DCA, 2021) stray comma STILL fires R. 10.5', () => {
  const text = 'Smith v. Jones, 123 So. 3d 456 (Fla. 4th DCA, 2021)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5' && /comma before the year/.test(f.message));
  assert.ok(r105, 'Existing R. 10.5 stray-comma catch must still fire after slip-opinion guard');
});

test('Round 27 Bug A — slip-opinion 4th Cir. Sept. 18 date does NOT fire', () => {
  const text = 'Smith v. Jones, 1 F.4th 1 (4th Cir. Sept. 18, 2024)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5' && /comma before the year/.test(f.message));
  assert.equal(r105, undefined, 'Sept. 18 internal date comma must not fire');
});

test('Round 27 Bug A — slip-opinion 10th Cir. Jan. 2 date does NOT fire', () => {
  const text = 'Boe v. Doe, 1 F.4th 1 (10th Cir. Jan. 2, 2023)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5' && /comma before the year/.test(f.message));
  assert.equal(r105, undefined);
});

test('Round 27 Bug A — internet-cite (Mar. 14, 2024) regression check (no R. 10.5)', () => {
  // Round 16 originally guarded against this. Make sure the Round 27
  // refactor of the date guard didn't break it.
  const text = 'See ACME blog (Mar. 14, 2024)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5');
  assert.equal(r105, undefined, 'Internet-cite date paren must not fire R. 10.5');
});

test('Round 27 Bug A — clean (2d Cir. 2019) does NOT fire R. 10.5', () => {
  const text = 'See foo (2d Cir. 2019)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r105 = flags.find((f) => f.rule_cite === 'BB R. 10.5');
  assert.equal(r105, undefined);
});

// ---------------------------------------------------------------------------
// Bug B — d/b/a walk-back preservation
// ---------------------------------------------------------------------------

function caseCandidate(text) {
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  return cands.find((c) => c.provisional_type === 'case');
}

test('Round 27 Bug B — Robertson d/b/a preserves full case name', () => {
  const text =
    'See Robertson, Inc., d/b/a Robertson Industries v. Cromwell, 412 F.3d 234, 241 (5th Cir. 2005).';
  const cand = caseCandidate(text);
  assert.ok(cand, 'Robertson must extract as case candidate');
  assert.match(
    cand.candidate_text,
    /Robertson, Inc\., d\/b\/a Robertson Industries v\. Cromwell/,
    `Walk-back must preserve "Robertson, Inc., d/b/a Robertson Industries"; got: ${cand.candidate_text}`
  );
});

test('Round 27 Bug B — walks through f/k/a alias', () => {
  const text = 'See Acme Holdings, f/k/a Acme Corp. v. Smith, 100 U.S. 1 (2020).';
  const cand = caseCandidate(text);
  assert.ok(cand);
  assert.match(cand.candidate_text, /Acme Holdings, f\/k\/a Acme Corp\. v\. Smith/);
});

test('Round 27 Bug B — walks through n/k/a alias', () => {
  const text = 'See Foo Co., n/k/a Bar Inc. v. Baz, 200 F.3d 1 (1st Cir. 2010).';
  const cand = caseCandidate(text);
  assert.ok(cand);
  assert.match(cand.candidate_text, /Foo Co\., n\/k\/a Bar Inc\. v\. Baz/);
});

test('Round 27 Bug B — walks through a/k/a alias', () => {
  const text = 'In a recent case, John Doe, a/k/a Jane Roe v. State, 50 P.2d 1 (Cal. 1990) held...';
  const cand = caseCandidate(text);
  assert.ok(cand);
  assert.match(cand.candidate_text, /John Doe, a\/k\/a Jane Roe v\. State/);
});

test('Round 27 Bug B — dotted dba variant (d.b.a.) walks through', () => {
  const text = 'See Smith, Inc., d.b.a. Smith Industries v. Jones, 100 U.S. 1 (2020).';
  const cand = caseCandidate(text);
  assert.ok(cand);
  assert.match(cand.candidate_text, /Smith, Inc\., d\.b\.a\. Smith Industries v\. Jones/);
});

test('Round 27 Bug B — clean case name (no d/b/a) still works', () => {
  const text = 'See Bell Atlantic Corp. v. Twombly, 550 U.S. 544 (2007).';
  const cand = caseCandidate(text);
  assert.ok(cand);
  assert.match(cand.candidate_text, /Bell Atlantic Corp\. v\. Twombly/);
});

test('Round 27 Bug B — a true sentence-boundary lowercase still STOPS walk-back', () => {
  // A genuine prose lowercase word must still terminate the walk-back —
  // our marker set is narrow (only d/b/a + aliases). Confirm "considered"
  // still stops the walk so candidate_text doesn't absorb sentence prose.
  const text = 'The Court has considered Smith v. Jones, 100 U.S. 1 (2020).';
  const cand = caseCandidate(text);
  assert.ok(cand);
  // The word "considered" is lowercase, non-connector → walk-back must stop.
  assert.equal(
    cand.candidate_text.startsWith('Smith v. Jones'),
    true,
    `Walk-back must stop at "considered"; got: ${cand.candidate_text}`
  );
});
