/**
 * Citation Verifier — corpus regression tests.
 *
 * End-to-end exercise of Pass 1 (extractor) + Pass 3 (validators) over
 * planted-error fixtures. Pass 2 (classifier) and Pass 4 (judgment)
 * require a live Anthropic API call so they're covered by manual
 * integration runs, not the unit suite.
 *
 * Run from site/ with:
 *   node --test netlify/lib/citation-verifier/__tests__/corpus.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';
import {
  validateCaseAbbreviations,
  validateReporterCurrency,
  validateCourtParenthetical,
  validateGeographicalAbbreviations,
} from '../validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixture(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture 1 — clean brief
// ---------------------------------------------------------------------------

test('corpus 1 (clean brief): Pass 1 finds at least 8 candidates', () => {
  const text = loadFixture('corpus-fixture-1-clean.txt');
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  assert.ok(cands.length >= 8, `expected ≥8 candidates, got ${cands.length}`);
});

test('corpus 1 (clean brief): per-citation T6 + reporter validators emit no non_conforming flags', () => {
  // We don't have Pass 2 here, so we manually construct the components
  // for each known-clean citation and run Pass 3 against them. If Pass 3
  // ever flags a clean cite we want CI to fail loudly.
  const cleanCitations = [
    { case_name: 'Brown v. Bd. of Educ.', reporter: 'U.S.', year: 1954 },
    { case_name: 'Loving v. Virginia',    reporter: 'U.S.', year: 1967 },
    { case_name: 'Smith v. Acme Corp.',   reporter: 'F.3d', year: 2015, court_parenthetical: '2d Cir. 2015' },
  ];

  for (const c of cleanCitations) {
    const flags = [
      ...validateCaseAbbreviations(c.case_name),
      ...validateReporterCurrency(c.reporter, c.year),
      ...validateCourtParenthetical(c.reporter, c.court_parenthetical || null),
    ];
    const nonConforming = flags.filter((f) => f.severity === 'non_conforming');
    assert.equal(nonConforming.length, 0,
      `clean citation "${c.case_name}, ${c.reporter}" should have zero non_conforming flags, got: ${JSON.stringify(nonConforming)}`);
  }
});

// ---------------------------------------------------------------------------
// Fixture 2 — planted errors
// ---------------------------------------------------------------------------

test('corpus 2 (planted errors): T6 catches every long-form word as advisory', () => {
  // Round 6: T6 word abbreviations are advisory (review severity).
  // Practitioner usage varies — Bluebook strictly requires the abbreviation
  // but many federal briefs use the full word. The flag still fires so
  // attorneys can decide; severity is 'review' rather than 'non_conforming'.
  const cases = [
    { name: 'Smith v. Acme Corporation',         word: 'Corporation',   abbrev: 'Corp.' },
    { name: 'Doe v. Board of Education',         word: 'Education',     abbrev: 'Educ.' },
    { name: 'Roe v. National Industries',        word: 'Industries',    abbrev: 'Indus.' },
  ];
  for (const c of cases) {
    const flags = validateCaseAbbreviations(c.name);
    const hit = flags.find((f) => f.message.includes(c.word));
    assert.ok(hit, `T6 should flag "${c.word}" in "${c.name}"`);
    assert.equal(hit.severity, 'review');
    assert.match(hit.suggested_fix, new RegExp(c.abbrev.replace('.', '\\.')));
  }
});

test('corpus 2 (planted errors): reporter-currency catches F.3d in 2022', () => {
  const flags = validateReporterCurrency('F.3d', 2022);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'non_conforming');
});

test('corpus 2 (planted errors): T7 catches "2nd Cir." and "DC Cir."', () => {
  const a = validateCourtParenthetical('F.3d', '2nd Cir. 2018');
  const b = validateCourtParenthetical('F.3d', 'DC Cir. 2010');
  assert.ok(a.find((f) => f.message.includes('2nd Cir.')));
  assert.ok(b.find((f) => f.message.includes('DC Cir.')));
});

test('corpus 2 (planted errors): T10 catches "Calif." → "Cal."', () => {
  const flags = validateGeographicalAbbreviations('Plaintiff v. Calif. State Univ.');
  const hit = flags.find((f) => f.message.includes('Calif.'));
  assert.ok(hit);
  assert.equal(hit.severity, 'non_conforming');
});

test('corpus 2 (planted errors): conforming control citations DO NOT trigger any non_conforming flags', () => {
  const controls = [
    { case_name: 'Brown v. Bd. of Educ.', reporter: 'U.S.', year: 1954 },
    { case_name: 'Smith v. Acme Corp.',   reporter: 'F.3d', year: 2015, court_parenthetical: '2d Cir. 2015' },
  ];
  for (const c of controls) {
    const flags = [
      ...validateCaseAbbreviations(c.case_name),
      ...validateReporterCurrency(c.reporter, c.year),
      ...validateCourtParenthetical(c.reporter, c.court_parenthetical || null),
    ];
    const nonConforming = flags.filter((f) => f.severity === 'non_conforming');
    assert.equal(nonConforming.length, 0,
      `control "${c.case_name}" must not trigger non_conforming flags. Got: ${JSON.stringify(nonConforming)}`);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: Pass 1 catches every citation in fixture 2 (extraction recall)
// ---------------------------------------------------------------------------

test('Pass 1 extraction recall on fixture 2 (planted errors)', () => {
  const text = loadFixture('corpus-fixture-2-planted-errors.txt');
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  // Fixture has roughly 10 case citations; high-recall regex should
  // find at least 8 of them.
  assert.ok(cands.length >= 8, `expected ≥8 candidates from fixture 2, got ${cands.length}`);
});
