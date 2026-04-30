/**
 * Citation Verifier — Pass 1 unit tests.
 *
 * Uses Node's built-in test runner (node:test) so we don't add a test
 * framework dependency to package.json. Run from site/ with:
 *
 *     node --test netlify/lib/citation-verifier/__tests__/extract.test.mjs
 *
 * The tests are organized by what we want Pass 1 to NEVER MISS — each
 * `assert` line is a citation type the regression suite must continue to
 * detect even as we tweak the patterns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';
import { parseFootnotesXml } from '../extract-docx.js';
import { pageNumberFor } from '../extract-pdf.js';
import { sha256Hex } from '../extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleBrief = readFileSync(join(__dirname, 'fixtures/sample-brief.txt'), 'utf8');

// ---------------------------------------------------------------------------
// citation-patterns.js
// ---------------------------------------------------------------------------

test('detects U.S. Supreme Court reporter citations', () => {
  const cands = findCitationCandidates(sampleBrief);
  const us = cands.filter((c) => c.candidate_text.includes('347 U.S. 483'));
  assert.ok(us.length >= 1, 'should find Brown v. Board, 347 U.S. 483');
});

test('detects federal courts of appeals citations (F.3d)', () => {
  const cands = findCitationCandidates(sampleBrief);
  const f3d = cands.filter((c) => c.candidate_text.includes('123 F.3d 456'));
  assert.ok(f3d.length >= 1, 'should find Smith v. Jones, 123 F.3d 456');
});

test('detects federal district court citations (F. Supp. 3d)', () => {
  const cands = findCitationCandidates(sampleBrief);
  const fsupp = cands.filter((c) => c.candidate_text.includes('100 F. Supp. 3d 200'));
  assert.ok(fsupp.length >= 1, 'should find Doe v. Roe, 100 F. Supp. 3d 200');
});

test('detects California state-court citations', () => {
  const cands = findCitationCandidates(sampleBrief);
  const cal = cands.filter((c) =>
    c.candidate_text.includes('50 Cal. 4th 100') ||
    c.candidate_text.includes('200 Cal. App. 4th')
  );
  assert.ok(cal.length >= 2, 'should find at least one Cal. 4th and one Cal. App. 4th cite');
});

test('detects New York state-court citations', () => {
  const cands = findCitationCandidates(sampleBrief);
  const ny = cands.filter((c) => c.candidate_text.includes('25 N.Y.3d 1'));
  assert.ok(ny.length >= 1, 'should find People v. Smith, 25 N.Y.3d 1');
});

test('detects federal statute citations (U.S.C.)', () => {
  const cands = findCitationCandidates(sampleBrief);
  const usc = cands.filter((c) => /\bU\.S\.C\.\s*§/.test(c.candidate_text));
  assert.ok(usc.length >= 2, 'should find both 42 U.S.C. § 1983 and 29 U.S.C. §§ 201-219');
});

test('detects regulation citations (C.F.R.)', () => {
  const cands = findCitationCandidates(sampleBrief);
  const cfr = cands.filter((c) => c.candidate_text.includes('29 C.F.R.'));
  assert.ok(cfr.length >= 1, 'should find 29 C.F.R. § 1630.2(g)');
});

test('detects constitutional citations', () => {
  const cands = findCitationCandidates(sampleBrief);
  const constCites = cands.filter((c) => /U\.S\. Const\./.test(c.candidate_text));
  assert.ok(constCites.length >= 2, 'should find both art. I and amend. XIV');
});

test('detects "Id." short forms', () => {
  const cands = findCitationCandidates(sampleBrief);
  const idCites = cands.filter((c) => c.provisional_type === 'short_form_id');
  assert.ok(idCites.length >= 1, 'should find Id. at 495');
  assert.ok(
    idCites.some((c) => /Id\. at \d+/.test(c.candidate_text)),
    'should preserve "Id. at <page>" form'
  );
});

test('detects "supra" short forms', () => {
  const cands = findCitationCandidates(sampleBrief);
  const supra = cands.filter((c) => c.provisional_type === 'short_form_supra');
  assert.ok(supra.length >= 1, 'should find "supra note 5"');
});

test('reaches backward to capture case names', () => {
  const cands = findCitationCandidates(sampleBrief);
  const brown = cands.find((c) =>
    c.candidate_text.includes('Brown v. Board') &&
    c.candidate_text.includes('347 U.S. 483')
  );
  assert.ok(brown, 'reach-back should fold "Brown v. Board" into the candidate');
});

test('reaches forward to capture (court, year) parenthetical', () => {
  const cands = findCitationCandidates(sampleBrief);
  const smith = cands.find((c) =>
    c.candidate_text.includes('123 F.3d 456') &&
    c.candidate_text.includes('2019')
  );
  assert.ok(smith, 'reach-forward should fold "(2d Cir. 2019)" into the candidate');
});

test('candidates carry char_start/char_end matching the source text', () => {
  const cands = findCitationCandidates(sampleBrief);
  for (const c of cands) {
    const slice = sampleBrief.slice(c.char_start, c.char_end);
    assert.equal(slice, c.candidate_text, `offset mismatch for "${c.candidate_text}"`);
  }
});

test('dropContainedDuplicates removes fully-contained spans', () => {
  const fake = [
    { char_start: 0,  char_end: 20, candidate_text: 'outer' },
    { char_start: 5,  char_end: 15, candidate_text: 'inner' },
    { char_start: 30, char_end: 40, candidate_text: 'next'  },
  ];
  const out = dropContainedDuplicates(fake);
  assert.equal(out.length, 2);
  assert.equal(out[0].candidate_text, 'outer');
  assert.equal(out[1].candidate_text, 'next');
});

// ---------------------------------------------------------------------------
// extract-docx.js — footnotes XML parser
// ---------------------------------------------------------------------------

test('parseFootnotesXml extracts footnote text and skips separators', () => {
  const xml = `<?xml version="1.0"?>
  <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:footnote w:type="separator" w:id="0">
      <w:p><w:r><w:separator/></w:r></w:p>
    </w:footnote>
    <w:footnote w:type="continuationSeparator" w:id="1">
      <w:p><w:r><w:continuationSeparator/></w:r></w:p>
    </w:footnote>
    <w:footnote w:id="2">
      <w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:r><w:t>Brown v. Board, 347 U.S. 483 (1954).</w:t></w:r></w:p>
    </w:footnote>
    <w:footnote w:id="3">
      <w:p><w:r><w:t>Id. at 495.</w:t></w:r></w:p>
    </w:footnote>
  </w:footnotes>`;
  const fns = parseFootnotesXml(xml);
  assert.equal(fns.length, 2, 'separator and continuationSeparator should be skipped');
  assert.equal(fns[0].num, 2);
  assert.match(fns[0].text, /Brown v\. Board, 347 U\.S\. 483/);
  assert.equal(fns[1].num, 3);
  assert.match(fns[1].text, /Id\. at 495/);
});

test('parseFootnotesXml handles XML entities', () => {
  const xml = `<?xml version="1.0"?>
  <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:footnote w:id="2">
      <w:p><w:r><w:t>Smith &amp; Jones &lt;v.&gt; Doe</w:t></w:r></w:p>
    </w:footnote>
  </w:footnotes>`;
  const fns = parseFootnotesXml(xml);
  assert.equal(fns.length, 1);
  assert.equal(fns[0].text, 'Smith & Jones <v.> Doe');
});

// ---------------------------------------------------------------------------
// extract-pdf.js — page mapping
// ---------------------------------------------------------------------------

test('pageNumberFor maps offsets to 1-based page numbers', () => {
  const pageStarts = [0, 100, 250, 500];
  assert.equal(pageNumberFor(0,    pageStarts), 1);
  assert.equal(pageNumberFor(50,   pageStarts), 1);
  assert.equal(pageNumberFor(99,   pageStarts), 1);
  assert.equal(pageNumberFor(100,  pageStarts), 2);
  assert.equal(pageNumberFor(249,  pageStarts), 2);
  assert.equal(pageNumberFor(250,  pageStarts), 3);
  assert.equal(pageNumberFor(499,  pageStarts), 3);
  assert.equal(pageNumberFor(500,  pageStarts), 4);
  assert.equal(pageNumberFor(9999, pageStarts), 4);
});

test('pageNumberFor returns null on empty page_starts', () => {
  assert.equal(pageNumberFor(0, []), null);
  assert.equal(pageNumberFor(0, null), null);
});

// ---------------------------------------------------------------------------
// extract.js — sha256
// ---------------------------------------------------------------------------

test('sha256Hex produces a 64-char hex digest', () => {
  const h = sha256Hex(Buffer.from('hello, world', 'utf8'));
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('sha256Hex is deterministic', () => {
  const a = sha256Hex(Buffer.from('same input', 'utf8'));
  const b = sha256Hex(Buffer.from('same input', 'utf8'));
  assert.equal(a, b);
});
