/**
 * Statute fetcher — server-side waterfall.
 *
 * Tries the state's official site first, then Cornell LII (rate-
 * limited per Cornell's robots.txt 10s crawl-delay), then Justia.
 * Caches successful fetches in workspace_law_cache for 7 days.
 *
 * Pure ESM, runtime-portable. Caller passes:
 *   - sb: a thin Supabase REST client ({ select, insert, upsert })
 *   - fetchImpl: optional fetch override (defaults to globalThis.fetch)
 *
 * No env reads, no Node-only APIs.
 */

import { findState } from './state-statutes.js';
import { parseStatuteHTML } from './statute-parsers.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 days
const FETCH_TIMEOUT_MS = 8000;
const CORNELL_DELAY_MS = 10_000;

// Module-level token bucket for Cornell. Per-instance only; on
// serverless this is good enough since instances rarely overlap
// on the same chat. Heavy concurrent load could exceed 1 req/10s
// across instances — accept that risk for v1; the cache absorbs
// repeats.
let _nextCornellAt = 0;

async function acquireCornellSlot() {
  const now = Date.now();
  if (now < _nextCornellAt) {
    await new Promise((r) => setTimeout(r, _nextCornellAt - now));
  }
  _nextCornellAt = Date.now() + CORNELL_DELAY_MS;
}

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
 * Look up a cached entry for this URL. Returns null on miss/expired.
 */
async function loadCache({ sb, url }) {
  if (!sb?.select) return null;
  try {
    const rows = await sb.select(
      `workspace_law_cache?url=eq.${encodeURIComponent(url)}&select=parsed_text,fetched_at,expires_at,http_status,source`
    );
    const row = rows?.[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    if (!row.parsed_text) return null;
    return row;
  } catch (err) {
    // Cache miss on error — log but don't fail the fetch
    console.warn('[statute-fetcher] cache load failed:', err?.message);
    return null;
  }
}

async function saveCache({ sb, url, source, http_status, parsed_text, raw_html_size }) {
  if (!sb?.upsert) return;
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
    await sb.upsert('workspace_law_cache', {
      url, source, http_status, parsed_text,
      raw_html_size: raw_html_size || null,
      fetched_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.warn('[statute-fetcher] cache save failed:', err?.message);
  }
}

/**
 * Fetch a single URL, parse statute body from HTML, cache result.
 * Returns { parsed_text, source_url, fetched_at, primary } on
 * success or null on any failure. Soft-fails on every error so the
 * waterfall can continue.
 */
async function fetchOne({ url, source, sb, fetchImpl }) {
  // Cache probe
  const cached = await loadCache({ sb, url });
  if (cached) {
    return {
      parsed_text: cached.parsed_text,
      source_url: url,
      fetched_at: cached.fetched_at,
      primary: source,
      from_cache: true,
    };
  }
  // Network
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'LegalOverflow-StatuteFetcher/1.0 (+https://legaloverflow.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, FETCH_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn(`[statute-fetcher] network error ${source} ${url}:`, err?.message);
    return null;
  }
  if (!res.ok) {
    console.warn(`[statute-fetcher] HTTP ${res.status} ${source} ${url}`);
    return null;
  }
  let html;
  try { html = await res.text(); } catch { return null; }
  const parsed = parseStatuteHTML(html, source);
  if (!parsed || parsed.length < 200) {
    // Too short → likely a page shell, not real statute text
    console.warn(`[statute-fetcher] thin parse ${source} ${url} chars=${parsed?.length || 0}`);
    return null;
  }
  await saveCache({
    sb, url, source,
    http_status: res.status,
    parsed_text: parsed,
    raw_html_size: html.length,
  });
  return {
    parsed_text: parsed,
    source_url: url,
    fetched_at: new Date().toISOString(),
    primary: source,
    from_cache: false,
  };
}

/**
 * Fetch a candidate statute via the waterfall.
 *
 * For v1 we don't try to construct deep section URLs — we just hit
 * the state's code root + its Cornell page + its Justia page and
 * let the LLM's web_search find specific sections within those
 * trees. The fetched root pages serve as anchored authoritative
 * source markers so the LLM knows which domains matter.
 *
 * @param {object} opts
 * @param {string} opts.state    — 2-letter state code
 * @param {object} opts.sb       — Supabase REST client {select, upsert}
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<object|null>} { parsed_text, source_url, primary, fetched_at } | null
 */
export async function fetchStatuteRoot({ state, sb, fetchImpl }) {
  const meta = findState(state);
  if (!meta) return null;

  // a) State official site
  const stateRes = await fetchOne({
    url: meta.code_url, source: 'state', sb, fetchImpl,
  });
  if (stateRes) return stateRes;

  // b) Cornell (rate-limited)
  if (meta.cornell_url) {
    await acquireCornellSlot();
    const cornellRes = await fetchOne({
      url: meta.cornell_url, source: 'cornell', sb, fetchImpl,
    });
    if (cornellRes) return cornellRes;
  }

  // c) Justia
  const justiaRes = await fetchOne({
    url: meta.justia_url, source: 'justia', sb, fetchImpl,
  });
  if (justiaRes) return justiaRes;

  return null;
}

/**
 * Verify a specific statute citation by URL — used during the
 * post-hoc verification pass. Hits the candidate URL through the
 * cache, returns whether the cited section text appears.
 *
 * @param {object} opts
 * @param {string} opts.url      — URL to verify (state, cornell, or justia)
 * @param {string} opts.source   — 'state' | 'cornell' | 'justia'
 * @param {string} [opts.expectedQuote] — short verbatim text to look for
 * @param {object} opts.sb
 * @returns {Promise<{ status: 'verified'|'unverified', source_url, fetched_at, primary, quote_found?: bool }>}
 */
export async function verifyStatuteUrl({ url, source, expectedQuote, sb, fetchImpl }) {
  const fetched = await fetchOne({ url, source, sb, fetchImpl });
  if (!fetched) return { status: 'unverified', source_url: url, primary: source };
  let quoteFound;
  if (expectedQuote && expectedQuote.length >= 8) {
    const norm = (s) => String(s).replace(/\s+/g, ' ').toLowerCase();
    quoteFound = norm(fetched.parsed_text).includes(norm(expectedQuote));
  }
  return {
    status: 'verified',
    source_url: fetched.source_url,
    fetched_at: fetched.fetched_at,
    primary: source,
    quote_found: quoteFound,
  };
}
