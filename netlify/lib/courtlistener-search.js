/**
 * CourtListener opinion search — for chat case-law grounding.
 *
 * Distinct from netlify/lib/citation-verifier/court-listener.js,
 * which is a heavyweight existence-checker tuned for the citation
 * verifier agent. This module is a lightweight free-text search
 * for the chat path: hit /api/rest/v4/search/?type=o, return the
 * top N opinions as snippets the LLM can ground in.
 *
 * Soft-fails on rate limit or any error — returns []. The chat
 * waterfall falls through to Justia / Cornell.
 *
 * Pure ESM, runtime-portable. Caller passes apiKey explicitly.
 */

const CL_BASE = 'https://www.courtlistener.com';
const SEARCH_PATH = '/api/rest/v4/search/';
const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Search CourtListener opinions.
 *
 * @param {object} opts
 * @param {string} opts.query        — free-text search (typically the user's message)
 * @param {string[]} [opts.courts]   — court IDs to filter (e.g. ['fla','flsupct'])
 * @param {number} [opts.limit=5]
 * @param {string} opts.apiKey
 * @returns {Promise<Array<{ id, case_name, court, date_filed, snippet, absolute_url, citation }>>}
 */
export async function searchCourtListenerOpinions({ query, courts, limit = 5, apiKey, fetchImpl }) {
  if (!query || !query.trim()) return [];
  const params = new URLSearchParams({ type: 'o', q: query.trim(), order_by: 'score desc' });
  if (courts && courts.length) {
    params.set('court', courts.join(','));
  }
  const url = `${CL_BASE}${SEARCH_PATH}?${params.toString()}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: apiKey
        ? { Authorization: `Token ${apiKey}` }
        : {},
    }, TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn('[cl-search] network error:', err?.message);
    return [];
  }
  if (res.status === 429) {
    console.warn('[cl-search] rate limited (429)');
    return [];
  }
  if (!res.ok) {
    console.warn(`[cl-search] HTTP ${res.status}`);
    return [];
  }
  let data;
  try { data = await res.json(); } catch { return []; }
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, limit).map((r) => ({
    id: String(r.id || r.cluster_id || ''),
    case_name: r.caseName || r.case_name || '',
    court: r.court || r.court_id || '',
    date_filed: r.dateFiled || r.date_filed || '',
    snippet: (r.snippet || '').slice(0, 800),
    absolute_url: r.absolute_url ? `${CL_BASE}${r.absolute_url}` : '',
    citation: Array.isArray(r.citation) ? r.citation.join('; ') : (r.citation || ''),
  }));
}

/**
 * Build the system-prompt block that grounds the model in the
 * pre-fetched opinions. Goes into the system prompt before the
 * model answers.
 */
export function buildCaseLawSystemBlock({ query, results, source = 'courtlistener' }) {
  if (!results || !results.length) return '';
  const lines = [
    `## Pre-fetched Case Law Anchors  [source=${source}]`,
    '',
    `These opinions were retrieved server-side for the user's question. Use them as primary case-law anchors when relevant. When you cite one, write the case name in italics + the standard reporter citation. Attach the absolute_url as a footnote-style markdown link "[N](url)" right after the citation — do NOT paste the URL as bare text in the prose. Do NOT fabricate additional cases beyond this list unless your web_search tool returns them.`,
    '',
  ];
  results.forEach((r, i) => {
    const yr = r.date_filed ? r.date_filed.slice(0, 4) : '';
    lines.push(`Case ${i + 1}: ${r.case_name}${r.citation ? `, ${r.citation}` : ''}${r.court ? ` (${r.court}` : ''}${yr ? `${r.court ? ' ' : ' ('}${yr})` : (r.court ? ')' : '')}`);
    if (r.absolute_url) lines.push(`   Footnote target: ${r.absolute_url}`);
    if (r.snippet) lines.push(`   Snippet: ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n');
}
