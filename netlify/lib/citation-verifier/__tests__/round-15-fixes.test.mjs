/**
 * Round 15 — Brief 4 rule additions.
 *
 *   R. 1.2  — signal capitalization (sentence-context awareness)
 *   R. 5.3  — ellipsis spacing
 *   R. 5.1  — block-quote-paragraph detection (50-word threshold)
 *   T6      — 8 new entries (Dep't, Nat'l, Fed'n, Indep., Gov't, Auth., Pub., Transp.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSignalCapitalization } from '../validators.js';
import { scanDocumentIssues } from '../scan-document-issues.js';
import T6JSON from '../tables/T6.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// R. 1.2 — signal capitalization
// ---------------------------------------------------------------------------

test('R. 1.2 — flags lowercase "see" at sentence start (after period)', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'short_form_case',
    pre_context: 'The Court reaffirmed the rule. see ',
    candidate_text: 'Anderson, 477 U.S. at 248',
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule_cite, 'BB R. 1.2');
  assert.match(flags[0].message, /capitalized/);
});

test('R. 1.2 — flags capitalised "Cf." mid-string-cite (after semicolon)', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'case',
    pre_context: '...; Cf. ',
    candidate_text: 'Scott v. Harris, 550 U.S. 372, 378 (2007)',
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule_cite, 'BB R. 1.2');
  assert.match(flags[0].message, /lowercase/);
});

test('R. 1.2 — flags capitalised "With" inside Compare/with', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'case',
    pre_context: '...Liberty Lobby, 477 U.S. at 252, With ',
    candidate_text: 'Saucier v. Katz, 533 U.S. 194, 201 (2001)',
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule_cite, 'BB R. 1.2');
  assert.match(flags[0].message, /lowercase/);
});

test('R. 1.2 — flags multi-word "but Cf." mid-string-cite', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'case',
    pre_context: '...; but Cf. ',
    candidate_text: 'United States v. X, 489 U.S. 749 (1989)',
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule_cite, 'BB R. 1.2');
  assert.match(flags[0].message, /lowercase/);
  assert.match(flags[0].message, /but cf\./);
});

test('R. 1.2 — does NOT flag correctly-cased "See" at sentence start', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'case',
    pre_context: 'standard. See ',
    candidate_text: 'Anderson v. Liberty Lobby, 477 U.S. 242 (1986)',
  });
  assert.equal(flags.length, 0);
});

test('R. 1.2 — does NOT flag correctly-cased "see" mid-string-cite', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'short_form_case',
    pre_context: '...; see ',
    candidate_text: 'Anderson, 477 U.S. at 248',
  });
  assert.equal(flags.length, 0);
});

test('R. 1.2 — does not run on non-case citations', () => {
  const flags = validateSignalCapitalization({
    citation_type: 'statute',
    pre_context: 'See ',
    candidate_text: '28 U.S.C. § 1331',
  });
  assert.equal(flags.length, 0);
});

// ---------------------------------------------------------------------------
// R. 5.3 — ellipsis spacing
// ---------------------------------------------------------------------------

test('R. 5.3 — flags "statements...are" without ellipsis spacing', () => {
  const text = 'The court held that "statements...are inadequate." Id. at 985.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.3');
  assert.ok(hit, 'should produce an R. 5.3 flag');
  assert.match(hit.flags[0].message, /spacing/i);
  assert.match(hit.flags[0].suggested_fix, /statements \. \. \. are/);
});

test('R. 5.3 — does NOT flag canonical " . . . "', () => {
  const text = 'The court said the rule . . . applies clearly.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.3');
  assert.equal(hit, undefined);
});

test('R. 5.3 — flags typographic horizontal ellipsis "…"', () => {
  const text = 'The court… spoke clearly.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.3');
  assert.ok(hit, 'should flag U+2026');
});

// ---------------------------------------------------------------------------
// R. 5.1 — block quote with too few words
// ---------------------------------------------------------------------------

test('R. 5.1 — flags 12-word indented paragraph after a colon', () => {
  const text = [
    'The court explained the burden:',
    '',
    '        The plaintiff has demonstrated that summary judgment is plainly inappropriate here.',
    '',
    'Celotex, 477 U.S. at 322. The full quotation makes clear...',
  ].join('\n');
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.1');
  assert.ok(hit, 'should flag short block quote');
  assert.match(hit.flags[0].message, /50/);
});

test('R. 5.1 — does NOT flag a 60+-word block quote', () => {
  const text = [
    'The court explained the burden:',
    '',
    '        ' + Array(70).fill('word').join(' ') + ' there.',
    '',
    'Celotex, 477 U.S. at 322.',
  ].join('\n');
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.1');
  assert.equal(hit, undefined);
});

test('R. 5.1 — does NOT flag indented section heading', () => {
  const text = [
    'Background.',
    '',
    '    I.  Standard of Review',
    '',
    'The Court must accept all well-pleaded allegations as true.',
  ].join('\n');
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 5.1');
  assert.equal(hit, undefined);
});

// ---------------------------------------------------------------------------
// T6 — 8 new entries from Brief 4
// ---------------------------------------------------------------------------

test('T6 — has all 8 Brief-4 entries', () => {
  const required = {
    'Department': "Dep't",
    'National': "Nat'l",
    'Federation': "Fed'n",
    'Independent': 'Indep.',
    'Government': "Gov't",
    'Authority': 'Auth.',
    'Public': 'Pub.',
    'Transportation': 'Transp.',
  };
  for (const [k, v] of Object.entries(required)) {
    assert.equal(T6JSON.abbreviations[k], v, `T6 should map "${k}" to "${v}"`);
  }
});
