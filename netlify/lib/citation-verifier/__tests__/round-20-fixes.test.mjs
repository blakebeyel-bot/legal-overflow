/**
 * Round 20 — Brief 8 foreign / treaty / tribunal / specialty validators.
 *
 *   R. 20    — UK / Australian / French / German foreign cases (jurisdiction tags)
 *   R. 21.4  — Multilateral + bilateral treaties (date + series citation)
 *   R. 21    — ICJ + ECHR international tribunals
 *   R. 10/T1 — Tax Court Memorandum publisher tag
 *
 * Critical FP-resistance: German + Sullivan (Australian) + Donoghue + Anns
 * controls must NOT fire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateForeignCase,
  validateMultilateralTreaty,
  validateBilateralTreaty,
  validateIcjCase,
  validateEchrCase,
  validateTcmCase,
} from '../validators.js';
import { findForeignSourceCandidates } from '../foreign-source-patterns.js';

// --- R. 20 foreign case --------------------------------------------------

test('R. 20 — flags Caparo (UK) missing court designator', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_uk',
    candidate_text: 'See Caparo Industries plc v. Dickman [1990] 2 AC 605',
  });
  const hit = flags.find((f) => /court designator/.test(f.message));
  assert.ok(hit);
});

test('R. 20 — flags Caparo (UK) missing jurisdiction tag', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_uk',
    candidate_text: 'See Caparo Industries plc v. Dickman [1990] 2 AC 605',
  });
  const hit = flags.find((f) => /jurisdiction tag/.test(f.message));
  assert.ok(hit);
});

test('R. 20 — does NOT flag Donoghue (Scot. inside parens)', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_uk',
    candidate_text: 'See Donoghue v. Stevenson [1932] AC 562 (HL) (appeal taken from Scot.)',
  });
  // Has both court designator (HL) and jurisdiction (Scot.).
  assert.equal(flags.length, 0);
});

test('R. 20 — does NOT flag Anns (Eng.)', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_uk',
    candidate_text: 'Anns v. Merton London Borough Council [1978] AC 728 (HL) (Eng.)',
  });
  assert.equal(flags.length, 0);
});

test('R. 20 — flags French Cass. without (Fr.)', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_french',
    candidate_text: 'Cass. civ. 1re, May 18, 2011, Bull. civ. I, No. 91',
  });
  const hit = flags.find((f) => /\(Fr\.\)/.test(f.message));
  assert.ok(hit);
});

test('R. 20 — does NOT flag Australian (Sullivan) with parens-year + (Austl.)', () => {
  const flags = validateForeignCase({
    provisional_type: 'foreign_case',
    citation_type: 'foreign_case',
    pattern_name: 'foreign_case_aus',
    candidate_text: 'Sullivan v. Moody (2001) 207 CLR 562 (Austl.)',
  });
  assert.equal(flags.length, 0);
});

// --- R. 21.4 treaties ----------------------------------------------------

test('R. 21.4 — flags Vienna missing signing date', () => {
  const flags = validateMultilateralTreaty({
    provisional_type: 'multilateral_treaty',
    citation_type: 'multilateral_treaty',
    candidate_text: 'Vienna Convention on the Law of Treaties, 1155 U.N.T.S. 331',
  });
  const hit = flags.find((f) => /signing date/.test(f.message));
  assert.ok(hit);
});

test('R. 21.4 — does NOT flag ICCPR (has Dec. 16, 1966 + 999 U.N.T.S.)', () => {
  const flags = validateMultilateralTreaty({
    provisional_type: 'multilateral_treaty',
    citation_type: 'multilateral_treaty',
    candidate_text: 'International Covenant on Civil and Political Rights art. 7, Dec. 16, 1966, 999 U.N.T.S. 171',
  });
  assert.equal(flags.length, 0);
});

test('R. 21.4 — flags Italy bilateral treaty missing T.I.A.S./Stat.', () => {
  const flags = validateBilateralTreaty({
    provisional_type: 'bilateral_treaty',
    citation_type: 'bilateral_treaty',
    candidate_text: 'Treaty of Friendship, Commerce and Navigation, U.S.-Italy, Feb. 2, 1948',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 21.4');
  assert.ok(hit);
});

test('R. 21.4 — does NOT flag U.S.-Gr. Brit. with 8 Stat. 116', () => {
  const flags = validateBilateralTreaty({
    provisional_type: 'bilateral_treaty',
    citation_type: 'bilateral_treaty',
    candidate_text: 'Treaty of Amity, Commerce and Navigation, U.S.-Gr. Brit., Nov. 19, 1794, 8 Stat. 116',
  });
  assert.equal(flags.length, 0);
});

// --- R. 21 ICJ + ECHR ----------------------------------------------------

test('R. 21 — flags ICJ Jurisdictional Immunities missing decision date', () => {
  const flags = validateIcjCase({
    provisional_type: 'icj_case',
    citation_type: 'icj_case',
    candidate_text: 'Jurisdictional Immunities of the State (Ger. v. It.), Judgment, 2012 I.C.J. 99',
  });
  const hit = flags.find((f) => /decision-date/.test(f.message));
  assert.ok(hit);
});

test('R. 21 — does NOT flag Barcelona Traction (has (Feb. 5))', () => {
  const flags = validateIcjCase({
    provisional_type: 'icj_case',
    citation_type: 'icj_case',
    candidate_text: 'Barcelona Traction, Light & Power Co. (Belg. v. Spain), Judgment, 1970 I.C.J. 3 (Feb. 5)',
  });
  assert.equal(flags.length, 0);
});

test('R. 21 — flags ECHR Saadi missing App. No.', () => {
  const flags = validateEchrCase({
    provisional_type: 'echr_case',
    citation_type: 'echr_case',
    candidate_text: 'Saadi v. Italy, 49 Eur. H.R. Rep. 30 (2008)',
  });
  const hit = flags.find((f) => /App\. No\./.test(f.message));
  assert.ok(hit);
});

test('R. 21 — does NOT flag Soering (has App. No. 14038/88)', () => {
  const flags = validateEchrCase({
    provisional_type: 'echr_case',
    citation_type: 'echr_case',
    candidate_text: 'Soering v. United Kingdom, App. No. 14038/88, 161 Eur. Ct. H.R. (ser. A) (1989)',
  });
  assert.equal(flags.length, 0);
});

// --- R. 10/T1 specialty federal -----------------------------------------

test('R. 10 — flags T.C.M. missing publisher tag', () => {
  const flags = validateTcmCase({
    provisional_type: 'tcm_case',
    citation_type: 'tcm_case',
    candidate_text: 'See Henderson v. Comm\'r, T.C.M. 2015-145',
  });
  const hit = flags.find((f) => /publisher tag/.test(f.message));
  assert.ok(hit);
});

test('R. 10 — does NOT flag T.C.M. with (CCH)', () => {
  const flags = validateTcmCase({
    provisional_type: 'tcm_case',
    citation_type: 'tcm_case',
    candidate_text: 'Henderson v. Comm\'r, T.C.M. 2015-145 (CCH)',
  });
  assert.equal(flags.length, 0);
});

// --- Critical FP-resistance: German case stress test ---------------------

test('German BGH stress test — multi-bracket format produces zero flags', () => {
  // The most complex foreign citation in the corpus. If this produces
  // any comment, the negative-space logic is too aggressive.
  const text = 'See Bundesgerichtshof [BGH] [Federal Court of Justice] Mar. 12, 2018, 218 Entscheidungen des Bundesgerichtshofes in Zivilsachen [BGHZ] 145, 152 (Ger.).';
  const cands = findForeignSourceCandidates(text);
  const german = cands.find((c) => c.pattern_name === 'foreign_case_german');
  assert.ok(german, 'should extract the German case as a foreign_case candidate');
  // Run validator — must NOT flag (jurisdiction tag (Ger.) is present).
  const flags = validateForeignCase(german);
  assert.equal(flags.length, 0, 'German case with (Ger.) tag must not produce flags');
});
