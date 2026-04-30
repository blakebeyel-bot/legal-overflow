/**
 * Round 8 — two surgical fixes.
 *
 *   1. CourtListener URL trailer
 *      - Removed from Pipeline A (format-error) comments entirely.
 *      - Kept on Pipeline B (existence-category) comments only.
 *      - URL is the human search page, not the API endpoint.
 *
 *   2. Halliburton lookup
 *      - Threshold dropped from 0.60 to 0.50.
 *      - Every name-comparison rejection logs a structured line so we
 *        can see which token-handling rule needs widening.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatCommentBody } from '../markup-shared.js';
import { caseNameMatches, caseNameOverlap } from '../court-listener.js';

// ---------------------------------------------------------------------------
// Fix 1 — URL trailer scope
// ---------------------------------------------------------------------------

test('URL trailer NOT appended to Pipeline A (format) comments', () => {
  // R. 10.2.1 is a format-rule flag (Pipeline A). Even if c.existence
  // carries a search_url, that URL has nothing to do with a "missing
  // v. period" finding and must NOT show up in the comment body.
  const flag = {
    severity: 'non_conforming',
    category: 'form_components',
    rule_cite: 'BB R. 10.2.1',
    table_cite: null,
    message: 'Case-name "v" must be followed by a period.',
    suggested_fix: 'Skinner v. Switzer, 562 U.S. 521, 530 (2011)',
  };
  const existence = {
    status: 'existence_verified',
    search_url: 'https://www.courtlistener.com/?type=o&q=562+U.S.+521',
  };
  const body = formatCommentBody(flag, existence);
  assert.doesNotMatch(body, /CourtListener search:/, 'URL must NOT appear on a Pipeline A flag');
});

test('URL trailer IS appended to Pipeline B (existence) comments', () => {
  const flag = {
    severity: 'review',
    category: 'existence',
    rule_cite: 'BB R. 10',
    table_cite: null,
    message: 'Not found in CourtListener.',
    suggested_fix: null,
  };
  const existence = {
    status: 'existence_not_found',
    search_url: 'https://www.courtlistener.com/?type=o&q=Whatever',
  };
  const body = formatCommentBody(flag, existence);
  assert.match(body, /CourtListener search: https:\/\/www\.courtlistener\.com\/\?type=o&q=Whatever/);
});

test('URL is the human search page, NOT /api/rest/...', () => {
  // Confirm the URL we surface is browseable by a human, not the JSON
  // API endpoint that returned during the lookup.
  const flag = {
    severity: 'review', category: 'existence', rule_cite: 'BB R. 10',
    table_cite: null, message: 'Not found.', suggested_fix: null,
  };
  const existence = {
    search_url: 'https://www.courtlistener.com/?type=o&q=Brown+347+U.S.+483',
  };
  const body = formatCommentBody(flag, existence);
  assert.doesNotMatch(body, /\/api\/rest\//, 'API endpoint must NEVER appear in user-visible comments');
  assert.match(body, /courtlistener\.com\/\?/, 'human search URL pattern: courtlistener.com/?...');
});

// ---------------------------------------------------------------------------
// Fix 2 — Halliburton & threshold tuning
// ---------------------------------------------------------------------------

test('Halliburton — exact match passes', () => {
  // Identical names — overlap = 1.0, well above 0.50.
  assert.equal(
    caseNameMatches(
      'Halliburton Co. v. Erica P. John Fund, Inc.',
      'Halliburton Co. v. Erica P. John Fund, Inc.'
    ),
    true
  );
});

test('Halliburton — Co./Company + Inc./Incorporated normalize, match passes', () => {
  // The expansion-direction-agnostic case the user called out earlier.
  assert.equal(
    caseNameMatches(
      'Halliburton Co. v. Erica P. John Fund, Inc.',
      'Halliburton Company v. Erica P. John Fund, Incorporated'
    ),
    true
  );
});

test('Halliburton — at the 0.50 threshold even when CL drops a token', () => {
  // CL might store "Halliburton Co. v. Erica P. John Fund" without
  // "Inc." Cited tokens: {halliburton, co, erica, john, fund, inc}
  // CL tokens: {halliburton, co, erica, john, fund}
  // Smaller set has 5; intersection has 5 → overlap = 1.0 → passes.
  assert.equal(
    caseNameMatches(
      'Halliburton Co. v. Erica P. John Fund, Inc.',
      'Halliburton Co. v. Erica P. John Fund'
    ),
    true
  );
});

test('Halliburton — extra "et al." on CL side passes (smaller-set denominator)', () => {
  assert.equal(
    caseNameMatches(
      'Halliburton Co. v. Erica P. John Fund, Inc.',
      'Halliburton Co., et al. v. Erica P. John Fund, Inc., et al.'
    ),
    true
  );
});

test('Halliburton — debug overlap score (sanity check)', () => {
  // If this number is < 0.50 we have a real normalization bug.
  const overlap = caseNameOverlap(
    'Halliburton Co. v. Erica P. John Fund, Inc.',
    'Halliburton Co. v. Erica P. John Fund, Inc.'
  );
  assert.equal(overlap, 1.0, `expected 1.0 on identical names, got ${overlap}`);
});

test('Threshold 0.50 — totally different cases still reject', () => {
  // Smaller set denominator + 0.50 threshold should NOT cause Brown
  // v. Board to match Roe v. Wade just because they share "v" tokens
  // (which we filter as length-1).
  assert.equal(
    caseNameMatches('Brown v. Board of Education', 'Roe v. Wade'),
    false
  );
});
