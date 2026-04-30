/**
 * Citation Verifier — markup-docx-citations adapter tests.
 *
 * Tests the pure-function `buildFindings` + `formatCommentBody`. The
 * actual DOCX OOXML editing is covered by the upstream lib/markup-docx.js
 * test suite — we only verify our adapter shapes the inputs correctly.
 *
 *   node --test netlify/lib/citation-verifier/__tests__/markup-docx-citations.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFindings, formatCommentBody } from '../markup-docx-citations.js';

// ---------------------------------------------------------------------------
// formatCommentBody
// ---------------------------------------------------------------------------

test('formatCommentBody includes rule pin-cite + message', () => {
  const body = formatCommentBody({
    rule_cite: 'BB R. 10.2.2',
    table_cite: 'T6',
    message: 'Case-name word "Corporation" must be abbreviated as "Corp." per T6.',
    suggested_fix: 'Smith v. Acme Corp.',
  });
  assert.match(body, /BB R\. 10\.2\.2; T6/);
  assert.match(body, /Corporation/);
  assert.match(body, /Suggested fix: Smith v\. Acme Corp\./);
});

test('formatCommentBody works without table_cite', () => {
  const body = formatCommentBody({
    rule_cite: 'BB R. 4.1',
    table_cite: null,
    message: 'Id. across footnote break — re-verify.',
    suggested_fix: null,
  });
  assert.match(body, /^BB R\. 4\.1 — /);
  assert.doesNotMatch(body, /Suggested fix:/);
});

test('formatCommentBody appends CourtListener search URL when present (Pipeline B only)', () => {
  // Round 8 — URL trailer appears ONLY on existence-category flags.
  // Test must include category='existence' for the URL to surface.
  const body = formatCommentBody(
    { rule_cite: 'BB R. 10', category: 'existence',
      message: 'Could not be located.', suggested_fix: null },
    { search_url: 'https://courtlistener.com/search/?q=...' }
  );
  assert.match(body, /CourtListener search: https:\/\/courtlistener/);
});

// ---------------------------------------------------------------------------
// buildFindings
// ---------------------------------------------------------------------------

test('buildFindings emits annotate finding for any flag (round 6.8: comments-only architecture)', () => {
  // Round 6.8 hard constraint: NEVER modify document body. Every flag
  // becomes a comment-only annotation. Suggested fix lives in the
  // comment body, not as inserted text.
  const citations = [{
    candidate_text: 'Smith v. Acme Corporation, 100 F.3d 200 (2d Cir. 2015)',
    flags: [
      { severity: 'review', category: 'abbreviations', rule_cite: 'BB R. 10.2.2', table_cite: 'T6',
        message: 'Case-name word "Corporation" must be abbreviated.',
        suggested_fix: 'Smith v. Acme Corp., 100 F.3d 200 (2d Cir. 2015)' },
    ],
  }];
  const findings = buildFindings(citations);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].markup_type, 'annotate');
  assert.match(findings[0].external_comment, /BB R\. 10\.2\.2; T6/);
  assert.match(findings[0].external_comment, /Suggested fix:.*Acme Corp\./);
});

test('buildFindings emits annotate finding for non_conforming flag (no auto-fix)', () => {
  const citations = [{
    candidate_text: 'Doe v. Roe, 100 X.Y.Z. 5',
    flags: [
      { severity: 'non_conforming', category: 'reporter', rule_cite: 'BB R. 10.3', table_cite: 'T1',
        message: 'Reporter "X.Y.Z." is not in T1 — please verify.', suggested_fix: null },
    ],
  }];
  const findings = buildFindings(citations);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].markup_type, 'annotate');
  assert.match(findings[0].external_comment, /not in T1/);
});

test('buildFindings emits annotate for existence flag pushed by orchestrator (Round 7 contract)', () => {
  // Round 7 — markup-shared.js NO LONGER synthesizes existence flags
  // from c.existence. The orchestrator is the sole source: it calls
  // existenceResultToFlag (with the suppression rule) and pushes the
  // flag onto c.flags BEFORE invoking buildFindings. This test
  // models that contract: existence flag is in c.flags, no
  // synthesis happens here.
  const citations = [{
    candidate_text: 'Made Up v. Citation, 999 F.3d 999 (1st Cir. 2020)',
    flags: [
      // Orchestrator already pushed this:
      { severity: 'review', category: 'existence', rule_cite: 'BB R. 10', table_cite: null,
        message: 'Not found in CourtListener.', suggested_fix: null },
    ],
    existence: { status: 'existence_not_found', search_url: 'https://courtlistener.com/?q=Made+Up' },
  }];
  const findings = buildFindings(citations);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].markup_type, 'annotate');
  assert.match(findings[0].external_comment, /Not found in CourtListener/i);
  // search_url comes from c.existence and is appended by formatCommentBody
  assert.match(findings[0].external_comment, /CourtListener search: /);
});

test('buildFindings emits multiple ANNOTATE findings when citation has form + existence flags (Round 7 contract)', () => {
  // Round 7 — orchestrator pushes both Pipeline A (T6) and Pipeline B
  // (existence) flags onto c.flags. buildFindings just iterates them.
  const citations = [{
    candidate_text: 'Smith v. Acme Corporation, 999 F.3d 999 (1st Cir. 2020)',
    flags: [
      { severity: 'review', category: 'abbreviations', rule_cite: 'BB R. 10.2.2', table_cite: 'T6',
        message: 'Corporation → Corp.', suggested_fix: 'Smith v. Acme Corp., 999 F.3d 999 (1st Cir. 2020)' },
      // Orchestrator-pushed existence flag (would normally be suppressed
      // since this citation has a Pipeline A flag — but for the markup
      // test we exercise the multi-flag path explicitly).
      { severity: 'review', category: 'existence', rule_cite: 'BB R. 10', table_cite: null,
        message: 'CourtListener returned an inconclusive result.', suggested_fix: null },
    ],
    existence: { status: 'existence_uncertain' },
  }];
  const findings = buildFindings(citations);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.markup_type, 'annotate');
  }
});

test('buildFindings emits no finding for ✓ conforming citations', () => {
  const citations = [{
    candidate_text: 'Brown v. Board of Educ., 347 U.S. 483 (1954)',
    flags: [],
    existence: { status: 'existence_verified' },
  }];
  assert.deepEqual(buildFindings(citations), []);
});

test('buildFindings sanitizes banned phrases in comment bodies', () => {
  const citations = [{
    candidate_text: 'Foo v. Bar, 100 F.3d 1',
    flags: [
      { severity: 'non_conforming', category: 'existence', rule_cite: 'BB R. 10', table_cite: null,
        message: 'This case appears fake and the citation does not exist.', suggested_fix: null },
    ],
  }];
  const findings = buildFindings(citations);
  assert.equal(findings.length, 1);
  assert.doesNotMatch(findings[0].external_comment, /\bfake\b/i);
  assert.doesNotMatch(findings[0].external_comment, /does not exist/i);
  assert.match(findings[0].external_comment, /could not be located in CourtListener/);
});

test('buildFindings skips citations with no candidate_text', () => {
  const citations = [{
    candidate_text: null, // privilege mode — text not retained
    flags: [
      { severity: 'review', rule_cite: 'BB R. 10', message: 'foo', suggested_fix: 'bar' },
    ],
  }];
  // Without source_text we cannot anchor. Skip rather than feed undefined.
  assert.deepEqual(buildFindings(citations), []);
});
