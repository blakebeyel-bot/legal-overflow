/**
 * Round 17 — Brief 6 official-source validators.
 *   R. 11   — constitutional citations (Roman numeral, art. period, state Const cap)
 *   R. 13.2 — bill missing congressional session
 *   R. 13.4 — committee report missing congressional prefix
 *   R. 6.2  — Cong. Rec. and Fed. Reg. comma in 4+ digit page numbers
 *   R. 14.2 — Federal Register missing volume number
 *   R. 8    — capitalization of Constitution / Congress / Bill of Rights / Court of Appeals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConstitutionalCitation,
  validateBillCitation,
  validateLegislativeReport,
  validateCongressionalRecord,
  validateFederalRegister,
} from '../validators.js';
import { findOfficialSourceCandidates } from '../official-source-patterns.js';
import { scanDocumentIssues } from '../scan-document-issues.js';

// --- R. 11 constitutional --------------------------------------------------

test('R. 11 — flags Arabic amendment number', () => {
  const flags = validateConstitutionalCitation({
    citation_type: 'constitutional',
    candidate_text: 'U.S. Const. amend. 14, § 5',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 11' && /Roman/.test(f.message));
  assert.ok(hit);
  assert.match(hit.suggested_fix, /XIV/);
});

test('R. 11 — flags missing period after "art"', () => {
  const flags = validateConstitutionalCitation({
    citation_type: 'constitutional',
    candidate_text: 'U.S. Const. art III, § 2',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 11' && /period/.test(f.message));
  assert.ok(hit);
});

test('R. 11 — flags lowercase state "const."', () => {
  const flags = validateConstitutionalCitation({
    citation_type: 'constitutional',
    candidate_text: 'Cal. const. art. I, § 7',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 11' && /Const/.test(f.message));
  assert.ok(hit);
});

test('R. 11 — does NOT flag canonical "U.S. Const. art. I, § 8, cl. 3"', () => {
  const flags = validateConstitutionalCitation({
    citation_type: 'constitutional',
    candidate_text: 'U.S. Const. art. I, § 8, cl. 3',
  });
  assert.equal(flags.length, 0);
});

// --- R. 13 legislative ----------------------------------------------------

test('R. 13.2 — flags bill missing congressional session', () => {
  const flags = validateBillCitation({
    citation_type: 'bill',
    candidate_text: 'S. 510 (2009)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 13.2');
  assert.ok(hit);
});

test('R. 13.2 — does NOT flag bill with congressional session', () => {
  const flags = validateBillCitation({
    citation_type: 'bill',
    candidate_text: 'H.R. 4173, 111th Cong. § 1031 (2010)',
  });
  assert.equal(flags.length, 0);
});

test('R. 13.4 — flags H.R. Rep. without congressional prefix', () => {
  const flags = validateLegislativeReport({
    citation_type: 'legislative_report',
    candidate_text: 'H.R. Rep. No. 1234, at 8 (1998)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 13.4');
  assert.ok(hit);
});

test('R. 13.4 — does NOT flag canonical "H.R. Rep. No. 117-456"', () => {
  const flags = validateLegislativeReport({
    citation_type: 'legislative_report',
    candidate_text: 'H.R. Rep. No. 117-456, at 23 (2022)',
  });
  assert.equal(flags.length, 0);
});

test('R. 6.2 — flags Cong. Rec. page without comma', () => {
  const flags = validateCongressionalRecord({
    citation_type: 'cong_rec',
    candidate_text: '165 Cong. Rec. 23456 (2019)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 6.2');
  assert.ok(hit);
  assert.match(hit.suggested_fix, /23,456/);
});

test('R. 6.2 — does NOT flag Cong. Rec. with comma', () => {
  const flags = validateCongressionalRecord({
    citation_type: 'cong_rec',
    candidate_text: '163 Cong. Rec. 12,345 (2017)',
  });
  assert.equal(flags.length, 0);
});

// --- R. 14 administrative -------------------------------------------------

test('R. 14.2 — flags Fed. Reg. missing volume number', () => {
  const flags = validateFederalRegister({
    citation_type: 'fed_reg',
    candidate_text: 'Fed. Reg. 8,234 (Feb. 12, 2024)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 14.2');
  assert.ok(hit);
});

test('R. 6.2 — flags Fed. Reg. page without comma', () => {
  const flags = validateFederalRegister({
    citation_type: 'fed_reg',
    candidate_text: '86 Fed. Reg. 35421 (June 30, 2021)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 6.2');
  assert.ok(hit);
});

test('R. 14.2 — does NOT flag canonical "88 Fed. Reg. 56,789"', () => {
  const flags = validateFederalRegister({
    citation_type: 'fed_reg',
    candidate_text: '88 Fed. Reg. 56,789 (Aug. 17, 2023)',
  });
  assert.equal(flags.length, 0);
});

// --- R. 8 capitalization --------------------------------------------------

test('R. 8 — flags lowercase "the constitution"', () => {
  const text = 'Plaintiff\'s challenge is grounded in the constitution itself.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /Constitution/.test(c.flags[0].message));
  assert.ok(hit);
});

test('R. 8 — flags lowercase "congress"', () => {
  const text = 'Indeed, the agency exceeds the boundaries congress set in 1914.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /Congress/.test(c.flags[0].message));
  assert.ok(hit);
});

test('R. 8 — flags lowercase "the bill of rights"', () => {
  const text = 'These principles trace to the foundational text of the bill of rights.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /Bill of Rights/.test(c.flags[0].message));
  assert.ok(hit);
});

test('R. 8 — flags generic "Court of Appeals"', () => {
  const text = 'The Court of Appeals for the D.C. Circuit has confirmed Plaintiff\'s position.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /court of appeals/i.test(c.flags[0].message));
  assert.ok(hit);
});

test('R. 8 — does NOT flag "Congress has not authorized" (already capitalized)', () => {
  const text = 'Congress has not authorized the agency to act.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8');
  assert.equal(hit, undefined);
});

test('R. 8 — does NOT flag "The Constitution\'s nondelegation"', () => {
  const text = 'The Constitution\'s nondelegation principles forbid such action.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /Constitution/.test(c.flags[0].message));
  assert.equal(hit, undefined);
});

test('R. 8 — does NOT flag "This Court has previously addressed"', () => {
  const text = 'This Court has previously addressed similar issues.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8' && /Court/.test(c.flags[0].message));
  assert.equal(hit, undefined);
});

test('R. 8 — does NOT flag "Defendant\'s reliance" (named party)', () => {
  const text = 'Defendant\'s reliance on state-law preemption is misplaced.';
  const out = scanDocumentIssues(text);
  const hit = out.find((c) => c.flags?.[0]?.rule_cite === 'BB R. 8');
  assert.equal(hit, undefined);
});

// --- Extractor tests ------------------------------------------------------

test('extractor — captures U.S. Const. art. I citation', () => {
  const text = 'See U.S. Const. art. I, § 8, cl. 3 (Commerce Clause).';
  const cands = findOfficialSourceCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'constitutional');
  assert.ok(hit);
  assert.match(hit.candidate_text, /U\.S\. Const\./);
});

test('extractor — captures bill citation', () => {
  const text = 'See S. 510 (2009).';
  const cands = findOfficialSourceCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'bill');
  assert.ok(hit);
});

test('extractor — does NOT classify "U.S. 544 (2007)" as a bill', () => {
  // The lookbehind in BILL_RE prevents matches inside "<vol> U.S. <page>" cites.
  const text = 'See Bell Atl. Corp. v. Twombly, 550 U.S. 544 (2007).';
  const cands = findOfficialSourceCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'bill');
  assert.equal(hit, undefined);
});

test('extractor — captures Federal Register citation', () => {
  const text = 'See 88 Fed. Reg. 56,789 (Aug. 17, 2023).';
  const cands = findOfficialSourceCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'fed_reg');
  assert.ok(hit);
});

test('extractor — captures Cong. Rec. citation', () => {
  const text = 'See 163 Cong. Rec. 12,345 (2017).';
  const cands = findOfficialSourceCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'cong_rec');
  assert.ok(hit);
});
