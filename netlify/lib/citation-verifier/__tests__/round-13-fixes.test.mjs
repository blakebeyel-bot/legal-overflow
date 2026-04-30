/**
 * Round 13 — four new rules + two Pass 4 bugs.
 *
 *   New rules:
 *     R. 4.2          — supra not permitted for cases
 *     R. 10.7 / T8    — subsequent-history phrases need periods
 *     R. 3.2(a)       — pin-cite ranges use en dash, not hyphen
 *     R. 6.1 / T6     — short-form abbreviations need trailing period
 *
 *   Bugs fixed:
 *     A — Pass 4 index leakage in user-facing comments
 *     B — Pass 4 misattributing R. 6.1/T6 issue to R. 10.9(a)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCitationForm,
  validateSupraForCase,
  validateShortFormAbbreviationPeriods,
} from '../validators.js';

// ---------------------------------------------------------------------------
// R. 10.7 / T8 — cert. denied
// ---------------------------------------------------------------------------

test('R. 10.7/T8 — flags "cert denied" without period', () => {
  const flags = validateCitationForm('Foo v. Bar, 100 F.3d 1 (2d Cir. 2010), cert denied, 200 U.S. 1 (2011)');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.7' && /cert/i.test(f.message));
  assert.ok(hit, 'should flag cert without period');
  assert.equal(hit.table_cite, 'T8');
  assert.match(hit.suggested_fix, /cert\. denied/);
});

test('R. 10.7/T8 — does NOT flag correctly formed "cert. denied"', () => {
  const flags = validateCitationForm('Foo v. Bar, 100 F.3d 1, cert. denied, 200 U.S. 1');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.7');
  assert.equal(hit, undefined);
});

test('R. 10.7/T8 — also flags "cert granted" without period', () => {
  const flags = validateCitationForm('cert granted, 590 U.S. 100 (2020)');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.7');
  assert.ok(hit);
  assert.match(hit.suggested_fix, /cert\. granted/);
});

// ---------------------------------------------------------------------------
// R. 3.2(a) — en dash in pin ranges
// ---------------------------------------------------------------------------

test('R. 3.2(a) — flags hyphen pin range "322-23"', () => {
  const flags = validateCitationForm('Smith v. Jones, 100 F.3d 320, 322-23 (2d Cir. 2010)');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.ok(hit, 'should flag hyphen in pin range');
  assert.match(hit.message, /en dash/);
  assert.match(hit.suggested_fix, /322–23/);
});

test('R. 3.2(a) — does NOT flag en dash pin range "322–23"', () => {
  const flags = validateCitationForm('Smith v. Jones, 100 F.3d 320, 322–23 (2d Cir. 2010)');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(hit, undefined);
});

test('R. 3.2(a) — does NOT flag hyphen inside section number (240.10b-5)', () => {
  // Hyphens in section numbers like "240.10b-5" are not pin ranges
  // because there's no preceding ", " (comma + space).
  const flags = validateCitationForm('17 C.F.R. § 240.10b-5 (2024)');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 3.2(a)');
  assert.equal(hit, undefined);
});

// ---------------------------------------------------------------------------
// R. 4.2 — supra for cases
// ---------------------------------------------------------------------------

test('R. 4.2 — flags supra reference (review severity)', () => {
  const citation = {
    provisional_type: 'short_form_supra',
    citation_type: 'short_form_supra',
    candidate_text: 'Iqbal, supra, at 679',
  };
  const flags = validateSupraForCase(citation);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule_cite, 'BB R. 4.2');
  assert.equal(flags[0].severity, 'review');
  assert.match(flags[0].message, /case short form/);
});

test('R. 4.2 — does not fire on non-supra citations', () => {
  const citation = {
    provisional_type: 'case',
    citation_type: 'case',
    candidate_text: 'Smith v. Jones, 100 F.3d 1',
  };
  const flags = validateSupraForCase(citation);
  assert.equal(flags.length, 0);
});

// ---------------------------------------------------------------------------
// R. 6.1 / T6 — short-form abbreviation periods
// ---------------------------------------------------------------------------

test('R. 6.1/T6 — flags "Atl" without period', () => {
  // "Bell Atl" appearing as a case-name shortform — should be "Bell Atl."
  const flags = validateShortFormAbbreviationPeriods('Bell Atl, 550 U.S. at 555');
  const hit = flags.find((f) => f.rule_cite === 'BB R. 6.1' && /Atl/.test(f.message));
  assert.ok(hit, 'should flag missing period after Atl');
  assert.equal(hit.table_cite, 'T6');
  assert.match(hit.suggested_fix, /Atl\./);
});

test('R. 6.1/T6 — does NOT flag correctly periodized "Atl."', () => {
  const flags = validateShortFormAbbreviationPeriods('Bell Atl., 550 U.S. at 555');
  const hit = flags.find((f) => /Atl/.test(f.message));
  assert.equal(hit, undefined);
});

test('R. 6.1/T6 — does NOT flag "Atlantic" (full word, not abbreviation)', () => {
  // The bare form "Atl" appears inside "Atlantic", but the regex's
  // negative lookahead for `[A-Za-z]` should prevent the match.
  const flags = validateShortFormAbbreviationPeriods('Bell Atlantic v. Twombly');
  const hit = flags.find((f) => /Atl"/.test(f.message));
  assert.equal(hit, undefined);
});
