/**
 * Case-law fetcher — server-side waterfall.
 *
 * Order:
 *   1. CourtListener   — primary; we have an API key + decent rate limit.
 *   2. Justia          — fallback when CL returns nothing.
 *   3. Cornell LII     — last resort, rate-limited.
 *
 * For v1 the Justia and Cornell fallbacks are stubbed: they return
 * an empty array but log so we can see when CL came up dry. Real
 * Justia/Cornell case-law search doesn't have a free public API,
 * so when those layers are needed we'd add a search-results-page
 * scrape. Out of scope for v1 — CL covers >95% of US opinions
 * already, and the chat's web_search tool can pick up the rest.
 *
 * Pure ESM, runtime-portable.
 */

import { searchCourtListenerOpinions } from './courtlistener-search.js';
import { STATE_TO_CL_COURTS } from './state-statutes.js';

/**
 * Run the case-law waterfall for a given query.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.state]   — state code; filters CL courts
 * @param {string} [opts.clApiKey]
 * @param {number} [opts.limit=5]
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<{ results: Array, primary: 'courtlistener'|'justia'|'cornell'|null } | null>}
 */
export async function fetchCaseLawForQuery({ query, state, clApiKey, limit = 5, fetchImpl }) {
  if (!query?.trim()) return null;
  const courts = state ? STATE_TO_CL_COURTS[state] || null : null;

  // 1) CourtListener
  const cl = await searchCourtListenerOpinions({
    query, courts, limit, apiKey: clApiKey, fetchImpl,
  });
  if (cl.length) {
    return { results: cl, primary: 'courtlistener' };
  }
  console.warn('[caselaw-fetcher] CL returned 0 results — no fallback search infra in v1, returning empty');

  // 2) Justia search (TODO — search-results-page parse)
  // 3) Cornell search (TODO — search-results-page parse, rate-limited)
  return null;
}
