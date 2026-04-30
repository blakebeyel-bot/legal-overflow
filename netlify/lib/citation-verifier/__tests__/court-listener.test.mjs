/**
 * Citation Verifier — CourtListener client tests.
 *
 * Uses a stub fetch so no real API calls happen. Live API behavior is
 * tested in Stage 12 with a recorded response fixture.
 *
 * Run from site/ with:
 *   node --test netlify/lib/citation-verifier/__tests__/court-listener.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CourtListenerClient,
  matchesComponents,
  existenceResultToFlag,
} from '../court-listener.js';

// Tiny helper: build a fetch stub that returns the given Response shape.
//
// The stub silently returns 404 for any v4 citation-lookup URL so the
// existing tests exercise the v3 search fallback (they were written
// before lookup existed). Lookup-specific behavior is covered by the
// "citation-lookup" tests at the bottom of this file.
function fetchStub(scenarios) {
  const calls = [];
  let i = 0;
  const fn = async (url, options) => {
    if (url.includes('citation-lookup')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    calls.push({ url, options });
    const scenario = scenarios[i] ?? scenarios[scenarios.length - 1];
    i++;
    if (scenario.throw) throw scenario.throw;
    return {
      ok: scenario.status >= 200 && scenario.status < 300,
      status: scenario.status,
      json: async () => scenario.body,
    };
  };
  fn.calls = calls;
  return fn;
}

const verifiedClassified = {
  citation_type: 'case',
  components: {
    case_name: 'Brown v. Board of Education',
    volume: 347,
    reporter: 'U.S.',
    first_page: 483,
  },
};

// ---------------------------------------------------------------------------
// matchesComponents — pure helper
// ---------------------------------------------------------------------------

test('matchesComponents accepts an exact-cite hit', () => {
  const result = { citation: ['347 U.S. 483'] };
  const components = { volume: 347, reporter: 'U.S.', first_page: 483 };
  assert.equal(matchesComponents(result, components), true);
});

test('matchesComponents accepts looser parallel-cite array', () => {
  const result = { citation: ['347 U.S. 483', '74 S. Ct. 686', '98 L. Ed. 873'] };
  const components = { volume: 74, reporter: 'S. Ct.', first_page: 686 };
  assert.equal(matchesComponents(result, components), true);
});

test('matchesComponents rejects mismatched volume', () => {
  const result = { citation: ['347 U.S. 483'] };
  const components = { volume: 999, reporter: 'U.S.', first_page: 483 };
  assert.equal(matchesComponents(result, components), false);
});

test('matchesComponents handles citation as a single string', () => {
  const result = { citation: '347 U.S. 483' };
  const components = { volume: 347, reporter: 'U.S.', first_page: 483 };
  assert.equal(matchesComponents(result, components), true);
});

test('matchesComponents rejects on missing components', () => {
  assert.equal(matchesComponents({ citation: ['347 U.S. 483'] }, {}), false);
  assert.equal(matchesComponents(null, { volume: 347 }), false);
});

// ---------------------------------------------------------------------------
// CourtListenerClient.checkExistence — happy paths and edge cases
// ---------------------------------------------------------------------------

test('checkExistence returns "verified" when top hit matches', async () => {
  const fetch = fetchStub([
    {
      status: 200,
      body: {
        count: 1,
        results: [{
          id: 12345,
          citation: ['347 U.S. 483'],
          absolute_url: '/opinion/12345/brown-v-board-of-education/',
        }],
      },
    },
  ]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence(verifiedClassified);
  assert.equal(r.status, 'existence_verified');
  assert.equal(r.opinion_id, '12345');
  assert.match(r.url, /brown-v-board-of-education/);
});

test('checkExistence returns "not_found" when count is 0', async () => {
  const fetch = fetchStub([
    { status: 200, body: { count: 0, results: [] } },
  ]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence(verifiedClassified);
  assert.equal(r.status, 'existence_not_found');
});

test('checkExistence returns "not_found" when results do not match the cited (vol/rep/page)', async () => {
  // Round-6 spec: any time CL returns no hit at the cited volume/
  // reporter/page (whether zero results or wrong results), this is
  // UNRESOLVED, not "uncertain." The orchestrator's suppression rule
  // decides whether to surface the comment.
  const fetch = fetchStub([
    {
      status: 200,
      body: {
        count: 1,
        results: [{
          id: 99,
          citation: ['1 F.3d 1'], // mismatched
          absolute_url: '/opinion/99/some-other/',
        }],
      },
    },
  ]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence(verifiedClassified);
  assert.equal(r.status, 'existence_not_found');
});

test('checkExistence returns "not_applicable" for non-case citations', async () => {
  const fetch = fetchStub([{ status: 200, body: { count: 0 } }]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence({
    citation_type: 'statute',
    components: { title: 42, code: 'U.S.C.', section: '1983' },
  });
  assert.equal(r.status, 'not_applicable');
  // No HTTP call should have been made.
  assert.equal(fetch.calls.length, 0);
});

test('checkExistence handles HTTP 429 by SILENTLY tripping daily-limit flag (FIX #2)', async () => {
  // FIX #2 — quota / infra messages NEVER reach the user as per-citation
  // comments. When 429 is hit, the citation gets `not_applicable` (silent)
  // and dailyLimitTripped is set so subsequent lookups also silent-skip.
  // The orchestrator can optionally surface a single end-of-run notice
  // via getRunSummary() — but never per citation.
  const fetch = fetchStub([{ status: 429, body: {} }]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence(verifiedClassified);
  assert.equal(r.status, 'not_applicable');
  assert.equal(r._silent_reason, 'quota_exhausted');
  assert.equal(client.dailyLimitTripped, true);

  // Subsequent call must also silently skip with no new HTTP call.
  const callsBefore = fetch.calls.length;
  const r2 = await client.checkExistence({
    citation_type: 'case',
    components: {
      case_name: 'Other v. Case',
      volume: 100,
      reporter: 'F.3d',
      first_page: 1,
    },
  });
  assert.equal(r2.status, 'not_applicable');
  assert.equal(r2._silent_reason, 'quota_exhausted');
  assert.equal(fetch.calls.length, callsBefore, 'should not make new HTTP call after limit trip');

  // Run summary surfaces the count for an optional end-of-run notice.
  const summary = client.getRunSummary();
  assert.ok(summary, 'getRunSummary should return a summary when quota tripped');
  assert.equal(summary.quota_exhausted_skips, 2);
  assert.match(summary.message, /daily quota/);
});

test('checkExistence caches identical lookups within a run', async () => {
  const fetch = fetchStub([
    {
      status: 200,
      body: {
        count: 1,
        results: [{ id: 1, citation: ['347 U.S. 483'], absolute_url: '/opinion/1/' }],
      },
    },
  ]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  await client.checkExistence(verifiedClassified);
  await client.checkExistence(verifiedClassified);
  await client.checkExistence(verifiedClassified);
  // Cache should suppress the 2nd and 3rd calls.
  assert.equal(fetch.calls.length, 1);
});

test('checkExistence handles network errors SILENTLY (FIX #2)', async () => {
  // FIX #2 — infrastructure failures never reach the user. Network
  // errors return `not_applicable` so existenceResultToFlag returns
  // null. The orchestrator can summarize via getRunSummary().
  const fetch = fetchStub([{ throw: new Error('ECONNRESET') }]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence(verifiedClassified);
  assert.equal(r.status, 'not_applicable');
  assert.equal(r._silent_reason, 'api_error');
  // Error must NOT trip the daily-limit flag.
  assert.equal(client.dailyLimitTripped, false);
  // But it IS counted for the run summary.
  assert.equal(client.apiErrorCount, 1);
});

test('checkExistence returns not_found when components are incomplete', async () => {
  // Round 6: incomplete components → UNRESOLVED (existence_not_found).
  // The orchestrator's suppression rule silences the comment when
  // Pipeline A flagged anything on this citation, which is the typical
  // reason components couldn't be parsed.
  const fetch = fetchStub([{ status: 200, body: { count: 1 } }]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });
  const r = await client.checkExistence({
    citation_type: 'case',
    components: { case_name: 'No Reporter v. Defendant' }, // missing volume/reporter/page
  });
  assert.equal(r.status, 'existence_not_found');
  assert.equal(r._reason, 'components_incomplete');
  // No HTTP call needed.
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// checkAll — concurrency + ordering
// ---------------------------------------------------------------------------

test('checkAll preserves input order across concurrent workers', async () => {
  const fetch = fetchStub([
    { status: 200, body: { count: 1, results: [{ id: 1, citation: ['100 F.3d 1'],   absolute_url: '/o/1/' }] } },
    { status: 200, body: { count: 1, results: [{ id: 2, citation: ['200 F.3d 2'],   absolute_url: '/o/2/' }] } },
    { status: 200, body: { count: 1, results: [{ id: 3, citation: ['300 F.3d 3'],   absolute_url: '/o/3/' }] } },
    { status: 200, body: { count: 0, results: [] } },
  ]);
  const client = new CourtListenerClient({ apiKey: 'test-key', fetchImpl: fetch });

  const citations = [
    { citation_type: 'case', components: { case_name: 'A', volume: 100, reporter: 'F.3d', first_page: 1 } },
    { citation_type: 'case', components: { case_name: 'B', volume: 200, reporter: 'F.3d', first_page: 2 } },
    { citation_type: 'case', components: { case_name: 'C', volume: 300, reporter: 'F.3d', first_page: 3 } },
    { citation_type: 'case', components: { case_name: 'D', volume: 400, reporter: 'F.3d', first_page: 4 } },
  ];
  const results = await client.checkAll(citations);

  assert.equal(results.length, 4);
  assert.equal(results[0].opinion_id, '1');
  assert.equal(results[1].opinion_id, '2');
  assert.equal(results[2].opinion_id, '3');
  assert.equal(results[3].status, 'existence_not_found');
});

// ---------------------------------------------------------------------------
// existenceResultToFlag
// ---------------------------------------------------------------------------

test('existenceResultToFlag returns null for verified', () => {
  assert.equal(existenceResultToFlag({ status: 'existence_verified' }), null);
});

test('existenceResultToFlag returns null for not_applicable', () => {
  assert.equal(existenceResultToFlag({ status: 'not_applicable' }), null);
});

test('existenceResultToFlag returns review-flag for not_found (round 6.10 message)', () => {
  const f = existenceResultToFlag({ status: 'existence_not_found' });
  assert.equal(f.severity, 'review');
  assert.equal(f.category, 'existence');
  // Round 6.10 spec rewrites the message to clarify that "not found"
  // ≠ "doesn't exist" and lists CourtListener's known coverage gaps.
  assert.match(f.message, /Not found in CourtListener/);
  assert.match(f.message, /Inability to locate is not evidence of nonexistence/);
  // Banned-phrase audit
  assert.doesNotMatch(f.message, /\b(?:fake|fictitious|hallucinat|incorrect|wrong|does not exist)\b/i);
});

test('existenceResultToFlag returns review-flag for uncertain (round 6.10 unified message)', () => {
  const f = existenceResultToFlag({
    status: 'existence_uncertain',
    note: 'Custom note from the client.',
  });
  assert.equal(f.severity, 'review');
  // Round 6.10: uncertain and not_found share the same canonical
  // message — "Not found in CourtListener" with the gap-coverage
  // explanation. The free-form `note` field is no longer used.
  assert.match(f.message, /Not found in CourtListener/);
});

test('existenceResultToFlag suppresses UNRESOLVED when format error already present (round 6.10)', () => {
  const r1 = existenceResultToFlag(
    { status: 'existence_not_found' },
    { hasFormatError: true }
  );
  const r2 = existenceResultToFlag(
    { status: 'existence_uncertain' },
    { hasFormatError: true }
  );
  // Per spec: format error in same citation suppresses the
  // existence-not-found / uncertain comment.
  assert.equal(r1, null);
  assert.equal(r2, null);
});

test('existenceResultToFlag returns NAME_MISMATCH flag when status is name_mismatch', () => {
  const f = existenceResultToFlag({
    status: 'existence_name_mismatch',
    cited_text: '347 U.S. 483',
    actual_case_name: 'Real Case Name',
    actual_year: 1954,
    url: 'https://courtlistener.com/...',
  });
  assert.equal(f.severity, 'review');
  assert.match(f.message, /Real Case Name/);
  assert.match(f.message, /does not match/);
});

test('existenceResultToFlag returns LOCATION_MISMATCH flag when status is location_mismatch', () => {
  const f = existenceResultToFlag({
    status: 'existence_location_mismatch',
    cited_text: '100 F.3d 200',
    actual_citation: '101 F.3d 250',
  });
  assert.equal(f.severity, 'review');
  assert.match(f.message, /101 F\.3d 250/);
  assert.match(f.message, /Verify the volume and page/);
});
