/**
 * Round 29 — ¶¶ paragraph-range consolidation.
 *
 * Long-document briefs produce dozens of ¶¶ N-M record citations with
 * hyphens. Each is a real R. 3.2(a) violation but the per-occurrence
 * comment volume buries substantive catches. Per user product decision
 * (Option 2): when a document contains 5+ HYPHEN ¶¶ ranges, emit ONE
 * consolidated advisory anchored at the first occurrence, with the
 * count, 2-3 examples, and a find-and-replace recommendation.
 *
 * Spec:
 *   • Threshold: 5 hyphen ¶¶ ranges. <5 → individual emission.
 *   • Em-dash ¶¶ ranges always fire individually.
 *   • Pin-cite ranges in case citations and Id. short-form ranges
 *     (handled by validators.js Patterns 1-2) are NOT consolidated.
 *   • Anchor on first occurrence in document order.
 *   • Count includes duplicates.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanDocumentIssues } from '../scan-document-issues.js';
import { runAllValidators } from '../validators.js';

// ---------------------------------------------------------------------------
// (a) Below threshold: 4 hyphens → 4 individual comments
// ---------------------------------------------------------------------------

test('Round 29 — 4 ¶¶ hyphens fire individually (below threshold)', () => {
  const text =
    'See Compl. ¶¶ 12-15. Also ¶¶ 30-35. And ¶¶ 100-110. Finally ¶¶ 200-210.';
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
        || i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(paraRange.length, 4, 'Below threshold must emit per-occurrence');
  for (const i of paraRange) {
    assert.equal(i.pattern_name, 'doc-issue-paragraph-range', 'Each must be the individual pattern');
  }
});

test('Round 29 — exactly 4 ¶¶ hyphens still fire individually (boundary check)', () => {
  const text = 'Compl. ¶¶ 1-5. SMF ¶¶ 10-15. Mot. ¶¶ 20-25. Pet. ¶¶ 30-35.';
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
        || i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(paraRange.length, 4);
});

// ---------------------------------------------------------------------------
// (b) At/above threshold: consolidated advisory
// ---------------------------------------------------------------------------

test('Round 29 — 5 ¶¶ hyphens fire as ONE consolidated advisory (at threshold)', () => {
  const text =
    'See Compl. ¶¶ 1-5. SMF ¶¶ 10-15. Mot. ¶¶ 20-25. Pet. ¶¶ 30-35. Br. ¶¶ 40-45.';
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
        || i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(paraRange.length, 1, '5 hyphens at threshold → 1 consolidated advisory');
  assert.equal(paraRange[0].pattern_name, 'doc-issue-paragraph-range-consolidated');
});

test('Round 29 — 10 ¶¶ hyphens fire as ONE consolidated advisory with count of 10', () => {
  let text = '';
  for (let i = 0; i < 10; i++) {
    text += `Compl. ¶¶ ${i * 10}-${i * 10 + 5}. `;
  }
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(paraRange.length, 1);
  const msg = paraRange[0].flags[0].message;
  assert.match(msg, /\b10 paragraph ranges\b/, `Message must report count of 10; got: ${msg}`);
});

test('Round 29 — consolidated advisory anchors on first occurrence', () => {
  const text = 'Some prose. Compl. ¶¶ 1-5. More prose ¶¶ 10-15, ¶¶ 20-25, ¶¶ 30-35, ¶¶ 40-45.';
  const issues = scanDocumentIssues(text);
  const consolidated = issues.find(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.ok(consolidated);
  assert.equal(
    consolidated.candidate_text,
    '¶¶ 1-5',
    `Anchor must be on first occurrence "¶¶ 1-5"; got: ${consolidated.candidate_text}`
  );
});

test('Round 29 — consolidated message lists 2-3 example ranges', () => {
  let text = '';
  for (let i = 0; i < 7; i++) {
    text += `¶¶ ${i + 1}-${i + 10}. `;
  }
  const issues = scanDocumentIssues(text);
  const consolidated = issues.find(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.ok(consolidated);
  const msg = consolidated.flags[0].message;
  // Must mention at least 2 examples in the message
  const exampleCount = (msg.match(/¶¶ \d+-\d+/g) || []).length;
  assert.ok(exampleCount >= 2 && exampleCount <= 3, `Expected 2-3 example ranges; got ${exampleCount}`);
});

test('Round 29 — consolidated message recommends find-and-replace', () => {
  let text = '';
  for (let i = 0; i < 6; i++) text += `¶¶ ${i}-${i + 5}. `;
  const issues = scanDocumentIssues(text);
  const consolidated = issues.find(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.ok(consolidated);
  const msg = consolidated.flags[0].message;
  assert.match(msg, /find-and-replace/i, 'Message must recommend find-and-replace');
});

test('Round 29 — duplicate ranges count toward total', () => {
  // 6 ¶¶ catches but only 2 distinct ranges (¶¶ 1-5 ×3, ¶¶ 10-15 ×3).
  const text = '¶¶ 1-5. ¶¶ 1-5. ¶¶ 1-5. ¶¶ 10-15. ¶¶ 10-15. ¶¶ 10-15.';
  const issues = scanDocumentIssues(text);
  const consolidated = issues.find(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.ok(consolidated);
  const msg = consolidated.flags[0].message;
  assert.match(msg, /\b6 paragraph ranges\b/, `Total must include duplicates: 6; got: ${msg}`);
});

// ---------------------------------------------------------------------------
// (c) Em-dash ¶¶ ranges fire individually regardless of count
// ---------------------------------------------------------------------------

test('Round 29 — em-dash ¶¶ ranges fire individually (not consolidated)', () => {
  const text =
    '¶¶ 1—5. ¶¶ 10—15. ¶¶ 20—25. ¶¶ 30—35. ¶¶ 40—45. ¶¶ 50—55.';
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
        || i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  // 6 em-dash matches, all individual; no consolidation.
  assert.equal(paraRange.length, 6);
  for (const p of paraRange) {
    assert.equal(p.pattern_name, 'doc-issue-paragraph-range');
  }
});

test('Round 29 — mixed: 6 hyphens consolidate, 2 em-dashes fire individually', () => {
  const text = [
    '¶¶ 1-5.', '¶¶ 10-15.', '¶¶ 20-25.', '¶¶ 30-35.', '¶¶ 40-45.', '¶¶ 50-55.',
    '¶¶ 100—105.', '¶¶ 200—205.',
  ].join(' ');
  const issues = scanDocumentIssues(text);
  const consolidated = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  const individual = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
  );
  assert.equal(consolidated.length, 1, '6 hyphens → 1 consolidated advisory');
  assert.equal(individual.length, 2, '2 em-dashes → 2 individual emissions');
});

// ---------------------------------------------------------------------------
// (d) Pin-cite ranges and Id. short-form ranges NOT consolidated
//
// These come from validators.js Patterns 1 and 2, NOT from scanParagraphRange.
// Confirming the consolidation is scoped to ¶¶ paragraph ranges only.
// ---------------------------------------------------------------------------

test('Round 29 — case-citation pin range does NOT trigger consolidation', () => {
  const text = 'Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 248-49 (1986)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'case' });
  const r32 = flags.filter((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(r32.length, 1, 'Case-citation pin range fires per occurrence');
  assert.match(r32[0].message, /Pin-cite range/);
});

test('Round 29 — Id. short-form pin range does NOT trigger consolidation', () => {
  const text = 'Id. at 250-52';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'short_form_id' });
  const r32 = flags.filter((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(r32.length, 1, 'Id. short-form range fires per occurrence');
  assert.match(r32[0].message, /Id\. short-form/);
});

test('Round 29 — case-citation pin ranges + ¶¶ consolidation coexist', () => {
  // Mixed scenario: many ¶¶ hyphens (consolidated) + a case-citation pin
  // hyphen (individual via validators.js Pattern 1).
  let text = '';
  for (let i = 0; i < 6; i++) text += `Compl. ¶¶ ${i}-${i + 5}. `;
  text += 'See Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 248-49 (1986).';

  // Doc-issue side
  const issues = scanDocumentIssues(text);
  const consolidated = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(consolidated.length, 1);

  // Validator side (pin-cite range in case citation)
  const caseText = 'Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 248-49 (1986)';
  const flags = runAllValidators({ candidate_text: caseText, citation_type: 'case' });
  const r32 = flags.filter((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(r32.length, 1, 'Case-citation pin range still fires individually');
});

// ---------------------------------------------------------------------------
// (e) No ¶¶ at all: scanner emits nothing
// ---------------------------------------------------------------------------

test('Round 29 — document with no ¶¶ ranges: no paragraph-range issues', () => {
  const text = 'Bell Atlantic Corp. v. Twombly, 550 U.S. 544 (2007).';
  const issues = scanDocumentIssues(text);
  const paraRange = issues.filter(
    (i) => i.pattern_name === 'doc-issue-paragraph-range'
        || i.pattern_name === 'doc-issue-paragraph-range-consolidated'
  );
  assert.equal(paraRange.length, 0);
});
