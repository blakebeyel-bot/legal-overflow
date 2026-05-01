/**
 * Round 28 — long-document brief fixes.
 *
 * Bug A — R. 12.9.5 over-fired on news-article titles containing the word
 *         "Restatement" (e.g., "Reserve Restatement, Wall St. J. (Nov. 14,
 *         2023)"). Validator's looksLikeCitation accepted any candidate
 *         with a year-parenthetical. Fix: require a series designator
 *         (canonical or short) OR series-less + § + ALI publisher.
 *
 * Bug B — RESTATEMENT_PATTERN truncated multi-segment subjects like
 *         "Restatement (Third) of Torts: Liab. for Econ. Harm § 9 cmt. b
 *         (Am. L. Inst. 2020)" at the colon, dropping the (Am. L. Inst.
 *         2020) parenthetical from candidate_text. Validator then
 *         falsely flagged the citation as missing its publisher. Fix:
 *         extend the pattern's subject + section + comment + publisher
 *         tail.
 *
 * Bug C — Walk-back stopped at lowercase "ex rel." in "Starr ex rel.
 *         Estate of Sampson v. ...", truncating the case name to "Estate
 *         of Sampson v. Georgeson Shareholder, Inc.". Pass 1's reach-
 *         forward also failed at "n.5" footnote pinpoints between the
 *         page and the year-parenthetical. Two fixes:
 *           (1) PARTY_INTERNAL_MARKERS adds 'ex', 'rel.', 'rel', 'parte'.
 *           (2) ABBREV_WORDS adds 'rel', 'ex' so findLatestSentenceBoundary
 *               doesn't treat "ex rel." as a sentence ender.
 *           (3) reachForwardForParenthetical accepts an optional " n.<digit>"
 *               between page and "(Court Year)".
 *
 * PSLRA — scanHereinafterUndeclared fired on "The Private Securities
 *         Litigation Reform Act" (4-word full statutory name). Real
 *         hereinafter abbreviations are 1-2 words; 3+-word names are
 *         full canonical titles, not shortenings. Fix: skip refs whose
 *         captured name is 3+ words.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAllValidators, scanHereinafterUndeclared } from '../validators.js';
import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';
import { findSecondarySourceCandidates } from '../secondary-source-patterns.js';

// ---------------------------------------------------------------------------
// Bug A — R. 12.9.5 trigger tightening
// ---------------------------------------------------------------------------

test('Round 28 Bug A — WSJ news article with "Restatement" in title does NOT fire R. 12.9.5', () => {
  const text = 'Brian Edwards, Northfield Energy Faces Reserve Restatement, Wall St. J. (Nov. 14, 2023), at A1, https://www.wsj.com/articles/northfield-energy-restatement.';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'internet' });
  const r1295 = flags.find((f) => f.rule_cite === 'BB R. 12.9.5');
  assert.equal(r1295, undefined, 'WSJ headline must not be flagged as a Restatement');
});

test('Round 28 Bug A — prose "the Restatement endorses..." does NOT fire R. 12.9.5', () => {
  const text = 'The Restatement endorses this approach.';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'unknown' });
  const r1295 = flags.find((f) => f.rule_cite === 'BB R. 12.9.5');
  assert.equal(r1295, undefined);
});

test('Round 28 Bug A — Restatement candidates with series STILL fire validator (no regression)', () => {
  const text = 'Restatement (Third) of Torts § 9';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'book' });
  // Should fire missing-publisher (no Am. L. Inst. parenthetical)
  const r1295 = flags.find((f) => f.rule_cite === 'BB R. 12.9.5');
  assert.ok(r1295, 'Series-having Restatement must still trigger validator (here: missing publisher)');
});

// ---------------------------------------------------------------------------
// Bug B — RESTATEMENT_PATTERN extends through subject + comment + publisher
// ---------------------------------------------------------------------------

function restatementCandidate(text) {
  return findCitationCandidates(text).find((c) => c.pattern_name === 'restatement');
}

test('Round 28 Bug B — Restatement candidate captures full subject incl. colon', () => {
  const text = 'See Restatement (Third) of Torts: Liab. for Econ. Harm § 9 cmt. b (Am. L. Inst. 2020).';
  const cand = restatementCandidate(text);
  assert.ok(cand, 'Must extract a Restatement candidate');
  assert.match(cand.candidate_text, /Liab\. for Econ\. Harm/, 'Subject after colon must be captured');
  assert.match(cand.candidate_text, /\(Am\. L\. Inst\. 2020\)/, 'Publisher parenthetical must be captured');
});

test('Round 28 Bug B — properly-formatted Restatement does NOT fire missing-publisher flag', () => {
  const text = 'Restatement (Third) of Torts: Liab. for Econ. Harm § 9 cmt. b (Am. L. Inst. 2020)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'book' });
  const missingPub = flags.find(
    (f) => f.rule_cite === 'BB R. 12.9.5' && /publisher\/year/.test(f.message)
  );
  assert.equal(missingPub, undefined, 'Citation already has (Am. L. Inst. 2020) — no flag');
});

test('Round 28 Bug B — series-LESS Restatement with § + ALI still fires R. 12.9.5 missing-series', () => {
  // Titan brief: "Restatement of Restitution and Unjust Enrichment § 1 (Am. L. Inst. 2011)"
  const text = 'Restatement of Restitution and Unjust Enrichment § 1 (Am. L. Inst. 2011)';
  const flags = runAllValidators({ candidate_text: text, citation_type: 'book' });
  const missingSeries = flags.find(
    (f) => f.rule_cite === 'BB R. 12.9.5' && /series designation/.test(f.message)
  );
  assert.ok(missingSeries, 'Series-less Restatement must still be flagged for missing series');
});

// ---------------------------------------------------------------------------
// Bug C — ex rel. walk-back + n.X reach-forward
// ---------------------------------------------------------------------------

test('Round 28 Bug C — Starr ex rel. Estate of Sampson preserves full case name', () => {
  const text =
    'particularly where the omissions are central to the alleged fraud. Starr ex rel. Estate of Sampson v. Georgeson Shareholder, Inc., 412 F.3d 103, 109 n.5 (2d Cir. 2005).';
  const cand = dropContainedDuplicates(findCitationCandidates(text)).find((c) => c.provisional_type === 'case');
  assert.ok(cand);
  assert.match(
    cand.candidate_text,
    /Starr ex rel\. Estate of Sampson v\. Georgeson Shareholder, Inc\./,
    'Walk-back must preserve "Starr ex rel."'
  );
});

test('Round 28 Bug C — n.5 footnote pinpoint included in candidate', () => {
  const text =
    'See Smith ex rel. Estate of Doe v. Jones, 100 F.3d 1, 5 n.12 (1st Cir. 2010).';
  const cand = dropContainedDuplicates(findCitationCandidates(text)).find((c) => c.provisional_type === 'case');
  assert.ok(cand);
  assert.match(cand.candidate_text, /5 n\.12 \(1st Cir\. 2010\)/, 'Reach-forward must include n.12 + court paren');
});

test('Round 28 Bug C — case without ex rel. still works (no regression)', () => {
  const text = 'See Bell Atlantic Corp. v. Twombly, 550 U.S. 544 (2007).';
  const cand = dropContainedDuplicates(findCitationCandidates(text)).find((c) => c.provisional_type === 'case');
  assert.ok(cand);
  assert.match(cand.candidate_text, /Bell Atlantic Corp\. v\. Twombly, 550 U\.S\. 544 \(2007\)/);
});

// ---------------------------------------------------------------------------
// PSLRA — scanHereinafterUndeclared 3+-word skip
// ---------------------------------------------------------------------------

test('Round 28 — PSLRA full statutory name (4 words) does NOT fire R. 4.2 hereinafter', () => {
  const text =
    'The Private Securities Litigation Reform Act\'s safe harbor protects forward-looking statements. ' +
    'Plaintiffs invoke the Securities Exchange Act of 1934 elsewhere.';
  const docFlags = scanHereinafterUndeclared(text);
  const psla = docFlags.find((d) => /Private Securities/.test(d.candidate_text || ''));
  assert.equal(psla, undefined, 'Full 4-word statutory name must not be flagged as undeclared hereinafter');
});

test('Round 28 — 1-2 word "The Investors Act" still fires hereinafter when undeclared', () => {
  // Regression check from Round 19 — ensure the validator still works for
  // typical 1-word hereinafter shortenings.
  const text =
    'The Investment Advisers Act of 1940 governs registered advisers. ' +
    'Plaintiff alleges fraud under the statute. The Investors Act addresses ' +
    'fiduciary duties.';
  const docFlags = scanHereinafterUndeclared(text);
  const inv = docFlags.find((d) => /Investors/.test(d.candidate_text || ''));
  assert.ok(inv, '1-word hereinafter shortening must still fire');
});

test('Round 28 — declared hereinafter form is NOT flagged', () => {
  const text =
    'The Securities Exchange Act of 1934 [hereinafter Exchange Act] governs. ' +
    'The Exchange Act establishes Section 10(b).';
  const docFlags = scanHereinafterUndeclared(text);
  const exch = docFlags.find((d) => /Exchange/.test(d.candidate_text || ''));
  assert.equal(exch, undefined);
});
