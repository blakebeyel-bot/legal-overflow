/**
 * Round 16 — secondary-source validators (Brief 5).
 *
 *   R. 15.1   — multi-volume treatise needs leading volume number
 *   R. 15.4   — book/treatise needs edition designation
 *   R. 16.4   — article needs volume + canonical journal abbreviation
 *   R. 17.1   — unpublished manuscript needs "(unpublished manuscript)" tag
 *   R. 17.2   — forthcoming article needs volume number
 *   R. 18.2   — news article needs URL
 *   R. 18.2.1 — internet URL should prefer https
 *   R. 18.2.3 — dynamic content needs "(last visited DATE)"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBookCitation,
  validateArticleCitation,
  validateManuscriptCitation,
  validateForthcomingCitation,
  validateInternetCitation,
  validateNewsArticleNeedsUrl,
} from '../validators.js';
import { findSecondarySourceCandidates } from '../secondary-source-patterns.js';

// --------- R. 15.1 multi-volume ---------------------------------------------

test('R. 15.1 — flags Patry without leading volume number', () => {
  const flags = validateBookCitation({
    citation_type: 'book',
    candidate_text: 'William F. Patry, Patry on Copyright § 4:17 (2024)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 15.1');
  assert.ok(hit, 'should flag missing volume on multi-volume Patry');
});

test('R. 15.1 — does NOT flag Nimmer with leading volume "4 ..."', () => {
  const flags = validateBookCitation({
    citation_type: 'book',
    candidate_text: '4 Melville B. Nimmer & David Nimmer, Nimmer on Copyright § 13.05 (Matthew Bender rev. ed. 2023)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 15.1');
  assert.equal(hit, undefined);
});

// --------- R. 15.4 edition --------------------------------------------------

test('R. 15.4 — flags Merges textbook missing edition, paren has only year', () => {
  const flags = validateBookCitation({
    citation_type: 'book',
    candidate_text: 'Robert P. Merges, Peter S. Menell & Mark A. Lemley, Intellectual Property in the New Technological Age 312 (2022)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 15.4');
  assert.ok(hit, 'should flag missing edition');
});

test('R. 15.4 — does NOT flag Restatement (handled by R. 12.9.5 separately)', () => {
  const flags = validateBookCitation({
    citation_type: 'book',
    candidate_text: 'Restatement (Third) of Unfair Competition § 38 (Am. L. Inst. 1995)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 15.4');
  assert.equal(hit, undefined);
});

// --------- R. 16.4 article --------------------------------------------------

test('R. 16.4 — flags long-form journal "University of Pennsylvania Law Review"', () => {
  const flags = validateArticleCitation({
    citation_type: 'article',
    candidate_text: 'Barton Beebe, An Empirical Study of U.S. Copyright Fair Use Opinions, 1978-2005, 156 University of Pennsylvania Law Review 549, 581 (2008)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 16.4');
  assert.ok(hit, 'should flag long-form journal name');
  assert.match(hit.suggested_fix, /U\. Pa\. L\. Rev\./);
});

test('R. 16.4 — flags Mitchell Note missing volume number', () => {
  const flags = validateArticleCitation({
    citation_type: 'article',
    candidate_text: 'Sarah Mitchell, Note, Algorithmic Copyright Enforcement and the DMCA Safe Harbor, Colum. L. Rev. 1422, 1437 (2023)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 16.4' && /volume/i.test(f.message));
  assert.ok(hit, 'should flag missing volume');
});

test('R. 16.4 — does NOT flag canonical "103 Harv. L. Rev. ..."', () => {
  const flags = validateArticleCitation({
    citation_type: 'article',
    candidate_text: 'Pierre N. Leval, Toward a Fair Use Standard, 103 Harv. L. Rev. 1105, 1111 (1990)',
  });
  assert.equal(flags.length, 0);
});

// --------- R. 17.1 unpublished manuscript -----------------------------------

test('R. 17.1 — flags manuscript with only "(on file with...)" tag', () => {
  const flags = validateManuscriptCitation({
    citation_type: 'manuscript',
    candidate_text: 'Maria Sanchez, Section 107 in Practice 14 (2024) (on file with the Stanford Law Library)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 17.1');
  assert.ok(hit, 'should flag missing (unpublished manuscript) tag');
});

test('R. 17.1 — does NOT flag manuscript with both tags', () => {
  const flags = validateManuscriptCitation({
    citation_type: 'manuscript',
    candidate_text: 'James L. Wright, Reproduction Rights in the Digital Era 28 (2023) (unpublished manuscript) (on file with author)',
  });
  assert.equal(flags.length, 0);
});

// --------- R. 17.2 forthcoming ----------------------------------------------

test('R. 17.2 — flags Tutt forthcoming missing volume', () => {
  const flags = validateForthcomingCitation({
    citation_type: 'forthcoming',
    candidate_text: 'Andrew Tutt, Copyright Damages Reform, Colum. L. Rev. (forthcoming 2025)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 17.2');
  assert.ok(hit, 'should flag missing volume on forthcoming');
});

test('R. 17.2 — does NOT flag Tushnet forthcoming with volume', () => {
  const flags = validateForthcomingCitation({
    citation_type: 'forthcoming',
    candidate_text: 'Rebecca Tushnet, Generative AI and the Fair Use Doctrine, 138 Harv. L. Rev. (forthcoming 2025) (manuscript at 12)',
  });
  assert.equal(flags.length, 0);
});

// --------- R. 18.2 internet -------------------------------------------------

test('R. 18.2.1 — flags http (prefer https)', () => {
  const flags = validateInternetCitation({
    citation_type: 'internet',
    candidate_text: 'Recording Indus. Ass\'n of Am., Position on AI Training (May 2024), http://www.riaa.com/policy/ai-training-position/',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 18.2.1');
  assert.ok(hit);
});

test('R. 18.2.3 — flags homepage URL missing (last visited)', () => {
  const flags = validateInternetCitation({
    citation_type: 'internet',
    candidate_text: 'U.S. Copyright Office, Copyright Registration Guidance, https://www.copyright.gov/registration/',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 18.2.3');
  assert.ok(hit, 'should flag missing last-visited on dynamic URL');
});

test('R. 18.2.3 — does NOT flag a date-pathed news URL', () => {
  const flags = validateInternetCitation({
    citation_type: 'internet',
    candidate_text: 'Adam Liptak, Supreme Court Hears Arguments, N.Y. Times (Mar. 14, 2024), https://www.nytimes.com/2024/03/14/us/scotus-copyright.html',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 18.2.3');
  assert.equal(hit, undefined);
});

test('R. 18.2 — flags news cite missing URL', () => {
  const flags = validateNewsArticleNeedsUrl({
    candidate_text: 'Ashley Cullins, Studios Press Their Case Before the Court, Hollywood Reporter (Aug. 22, 2024)',
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 18.2');
  assert.ok(hit, 'should flag news cite missing URL');
});

test('R. 18.2 — does NOT flag news cite with URL', () => {
  const flags = validateNewsArticleNeedsUrl({
    candidate_text: 'Adam Liptak, Supreme Court Hears Arguments, N.Y. Times (Mar. 14, 2024), https://www.nytimes.com/...',
  });
  assert.equal(flags.length, 0);
});

// --------- secondary-source extractor ---------------------------------------

test('extractor — captures law-review article with volume and journal', () => {
  const text = 'See Pierre N. Leval, Toward a Fair Use Standard, 103 Harv. L. Rev. 1105, 1111 (1990).';
  const cands = findSecondarySourceCandidates(text);
  const article = cands.find((c) => c.provisional_type === 'article' && /Leval/.test(c.candidate_text));
  assert.ok(article);
});

test('extractor — captures multi-volume treatise as book', () => {
  const text = '4 Melville B. Nimmer & David Nimmer, Nimmer on Copyright § 13.05 (Matthew Bender rev. ed. 2023).';
  const cands = findSecondarySourceCandidates(text);
  const book = cands.find((c) => c.provisional_type === 'book' && /Nimmer/.test(c.candidate_text));
  assert.ok(book);
});

test('extractor — does NOT classify a case citation as a book', () => {
  // Stoneridge has section-page-year shape that BOOK_END_RE matches, but
  // it contains " v. " — must be filtered out.
  const text = 'Stoneridge Investment Partners, LLC v. Scientific-Atlanta Inc., 552 U.S. 148, 158 (2008).';
  const cands = findSecondarySourceCandidates(text);
  const book = cands.find((c) => c.provisional_type === 'book');
  assert.equal(book, undefined);
});

test('extractor — captures manuscript with "(on file with...)" tail', () => {
  const text = 'Maria Sanchez, Section 107 in Practice 14 (2024) (on file with the Stanford Law Library).';
  const cands = findSecondarySourceCandidates(text);
  const ms = cands.find((c) => c.provisional_type === 'manuscript');
  assert.ok(ms);
});

test('extractor — captures internet citation with URL', () => {
  const text = 'Adam Liptak, Supreme Court Hears Arguments, N.Y. Times (Mar. 14, 2024), https://www.nytimes.com/path.html.';
  const cands = findSecondarySourceCandidates(text);
  const inet = cands.find((c) => c.provisional_type === 'internet');
  assert.ok(inet);
  assert.match(inet.candidate_text, /Adam Liptak/);
});
