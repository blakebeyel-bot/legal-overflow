/**
 * Case-existence fallback — Justia + Cornell.
 *
 * The primary existence check (court-listener.js) covers ~95% of US case
 * law. When it returns existence_not_found we follow up here before
 * surfacing the citation to the user as "not found in CourtListener".
 * Same waterfall idea the chatbot's statute path uses, ported to cases:
 *
 *   1. Justia — direct URL for SCOTUS (deterministic), site search for
 *              other reporters.
 *   2. Cornell — search the LII case index. Cornell is light on state
 *              cases but useful for SCOTUS / federal circuits.
 *
 * Soft-fails on every error: any HTTP failure, parse failure, or empty
 * result returns null and the upstream caller surfaces the original
 * "not found" verdict. Never a hard error — the fallback is a best-effort
 * upgrade, never a blocker.
 *
 * Pure ESM, runtime-portable. No env reads, no Node-only APIs.
 */

const FETCH_TIMEOUT_MS = 8_000;
const FALLBACK_CONCURRENCY = 3;

const DEFAULT_HEADERS = {
  'User-Agent': 'LegalOverflow-CitationVerifier/1.0 (+https://legaloverflow.com)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.7',
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try Justia's deterministic SCOTUS URL pattern first — Justia exposes
 *   https://supreme.justia.com/cases/federal/us/{vol}/{page}/
 * for every published US Reports volume/page pair. A 200 with substantive
 * body confirms the case exists at that location.
 */
async function tryJustiaScotus({ volume, first_page, fetchImpl }) {
  if (!volume || !first_page) return null;
  const url = `https://supreme.justia.com/cases/federal/us/${volume}/${first_page}/`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, FETCH_TIMEOUT_MS, fetchImpl);
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  let html = '';
  try { html = await res.text(); } catch { return null; }
  // Justia returns a thin 200 placeholder for some unfilled pages — gate
  // on body length and presence of the case-page <h1>.
  if (html.length < 4000) return null;
  if (!/<h1[^>]*>/i.test(html)) return null;
  // Scrape canonical case name out of the title for nicer UI later.
  const m = html.match(/<title>([^<]+?)\s*::\s*Justia/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return {
    status: 'existence_verified',
    url,
    source: 'justia',
    case_name: m ? m[1].trim().replace(/\s+/g, ' ') : null,
  };
}

/**
 * Justia federal-appellate URL pattern — works for many F./F.2d/F.3d
 * reporters. Best-effort: if it 404s we move on. Reporter slugs follow
 * the path Justia exposes on its case index.
 */
const JUSTIA_FEDERAL_REPORTER_SLUGS = {
  'F.': 'F',
  'F.2d': 'F2',
  'F.3d': 'F3',
  'F.4th': 'F4',
  'F. Supp.': 'FSupp',
  'F. Supp. 2d': 'FSupp2',
  'F. Supp. 3d': 'FSupp3',
};
async function tryJustiaFederalDirect({ reporter, volume, first_page, fetchImpl }) {
  const slug = JUSTIA_FEDERAL_REPORTER_SLUGS[reporter];
  if (!slug || !volume || !first_page) return null;
  const url = `https://law.justia.com/cases/federal/appellate-courts/${slug}/${volume}/${first_page}/`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, FETCH_TIMEOUT_MS, fetchImpl);
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  let html = '';
  try { html = await res.text(); } catch { return null; }
  if (html.length < 3000) return null;
  if (!/<h1[^>]*>/i.test(html)) return null;
  const m = html.match(/<title>([^<]+?)\s*::\s*Justia/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return {
    status: 'existence_verified',
    url,
    source: 'justia',
    case_name: m ? m[1].trim().replace(/\s+/g, ' ') : null,
  };
}

/**
 * Justia site search fallback — query their case index, look for a
 * results-page hit whose linked citation matches our volume+reporter+page.
 * The match is conservative: we require both the reporter token and the
 * volume/page numbers to appear together in the HTML, otherwise random
 * partial matches register as false positives.
 */
async function tryJustiaSearch({ case_name, volume, reporter, first_page, fetchImpl }) {
  if (!volume || !reporter || !first_page) return null;
  const queryPieces = [
    case_name ? `"${case_name}"` : null,
    `${volume} ${reporter} ${first_page}`,
  ].filter(Boolean);
  const query = queryPieces.join(' ');
  const searchUrl = `https://law.justia.com/cases/?query=${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetchWithTimeout(searchUrl, { headers: DEFAULT_HEADERS }, FETCH_TIMEOUT_MS, fetchImpl);
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  let html = '';
  try { html = await res.text(); } catch { return null; }
  // Confirm the citation pattern actually appears in the results body.
  // Build a regex tolerant to whitespace variation.
  const repEsc = reporter.replace(/[.\\+*?^$()|[\]{}]/g, '\\$&');
  const cite = new RegExp(`\\b${volume}\\s+${repEsc}\\s+${first_page}\\b`, 'i');
  if (!cite.test(html)) return null;
  // Try to extract the first canonical /cases/ link near the matched cite.
  const link = html.match(/<a [^>]*href="(\/cases\/[^"]+)"[^>]*>/i);
  const url = link ? `https://law.justia.com${link[1]}` : searchUrl;
  return {
    status: 'existence_verified',
    url,
    source: 'justia',
  };
}

/**
 * Cornell LII search fallback. Cornell's case coverage is uneven outside
 * SCOTUS, but the search URL is stable and the results page contains
 * citation strings we can pattern-match against. Soft-fail on anything.
 */
async function tryCornellSearch({ case_name, volume, reporter, first_page, fetchImpl }) {
  if (!volume || !reporter || !first_page) return null;
  const queryPieces = [
    case_name || null,
    `${volume} ${reporter} ${first_page}`,
  ].filter(Boolean);
  const query = queryPieces.join(' ');
  const searchUrl = `https://www.law.cornell.edu/search/site/${encodeURIComponent(query)}`;
  let res;
  try {
    res = await fetchWithTimeout(searchUrl, { headers: DEFAULT_HEADERS }, FETCH_TIMEOUT_MS, fetchImpl);
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  let html = '';
  try { html = await res.text(); } catch { return null; }
  const repEsc = reporter.replace(/[.\\+*?^$()|[\]{}]/g, '\\$&');
  const cite = new RegExp(`\\b${volume}\\s+${repEsc}\\s+${first_page}\\b`, 'i');
  if (!cite.test(html)) return null;
  const link = html.match(/<a [^>]*href="(\/[^"]*supremecourt[^"]+)"[^>]*>/i)
    || html.match(/<a [^>]*href="(\/[^"]*supct[^"]+)"[^>]*>/i);
  const url = link ? `https://www.law.cornell.edu${link[1]}` : searchUrl;
  return {
    status: 'existence_verified',
    url,
    source: 'cornell',
  };
}

/**
 * Verify a single case via the fallback waterfall. Returns null when
 * nothing in the waterfall could confirm existence — caller keeps the
 * original "not found" verdict in that case.
 *
 * @param {object} components  — Pass 2 components { volume, reporter, first_page, case_name, ... }
 * @param {function} [fetchImpl]
 * @returns {Promise<{status:'existence_verified',url:string,source:string,case_name?:string}|null>}
 */
export async function verifyCaseFallback({ components, fetchImpl } = {}) {
  if (!components) return null;
  const { volume, reporter, first_page, case_name } = components;
  if (!volume || !reporter || !first_page) return null;

  // 1. SCOTUS direct
  if (reporter === 'U.S.' || reporter === 'U.S') {
    const r = await tryJustiaScotus({ volume, first_page, fetchImpl });
    if (r) return r;
  }
  // 2. Federal reporter direct
  if (JUSTIA_FEDERAL_REPORTER_SLUGS[reporter]) {
    const r = await tryJustiaFederalDirect({ reporter, volume, first_page, fetchImpl });
    if (r) return r;
  }
  // 3. Justia site search (covers everything else)
  const j = await tryJustiaSearch({ case_name, volume, reporter, first_page, fetchImpl });
  if (j) return j;
  // 4. Cornell search (last resort; thin coverage outside SCOTUS)
  const c = await tryCornellSearch({ case_name, volume, reporter, first_page, fetchImpl });
  if (c) return c;
  return null;
}

/**
 * Bulk-run the fallback for an array of citations whose primary existence
 * check returned existence_not_found. Concurrency-capped so a 200-cite
 * brief doesn't open 200 sockets to Justia.
 *
 * @param {Array<{components: object, _origIndex: number}>} cites
 * @param {function} [fetchImpl]
 * @returns {Promise<Map<number, object>>} _origIndex → fallback result (or absent if not found)
 */
export async function checkAllFallback(cites, { fetchImpl } = {}) {
  const out = new Map();
  if (!cites?.length) return out;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FALLBACK_CONCURRENCY, cites.length) }, () =>
    (async () => {
      while (cursor < cites.length) {
        const i = cursor++;
        const c = cites[i];
        try {
          const r = await verifyCaseFallback({ components: c.components, fetchImpl });
          if (r) out.set(c._origIndex, r);
        } catch (err) {
          console.warn('[case-fallback] error:', err?.message);
        }
      }
    })()
  );
  await Promise.all(workers);
  return out;
}
