/**
 * LegiScan client — bills + amendment-freshness check.
 *
 * Two roles:
 *   1. When the LegiScan toggle is ON, search for bills matching
 *      the user's query in the selected state, inline as a
 *      "Legislative Activity" system-prompt block.
 *   2. When the Statutes toggle is on (toggle-LegiScan can be off),
 *      do a passive amendment-freshness check on every cited
 *      statute: search LegiScan for bills affecting that section,
 *      classify status as 'enacted', 'pending', or 'clean', and
 *      generate a conservative user-facing message.
 *
 * Pure ESM, runtime-portable. Caller passes apiKey explicitly.
 *
 * Soft-fails on every error (returns empty array / 'clean'
 * classification). Never blocks the chat. Never claims an
 * amendment is enacted when it is only pending.
 */

const LEGISCAN_BASE = 'https://api.legiscan.com/';
const TIMEOUT_MS = 8000;

/**
 * Status code → bucket.
 *
 * LegiScan status codes (per their docs):
 *   1 Introduced, 2 Engrossed, 3 Enrolled, 4 Passed (signed),
 *   5 Vetoed, 6 Failed/Dead. Plus various negotiation states.
 *
 * "Enacted" = bill became law (4 = Passed/signed, sometimes 3
 * Enrolled depending on state). We treat Vetoed/Failed/Dead as
 * NOT a concern (those don't change the statute). Anything else
 * (1, 2) is "pending".
 */
const ENACTED_STATUSES = new Set([4]);
const PENDING_STATUSES = new Set([1, 2, 3]);

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
 * Search bills in a given state matching free-text query.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} opts.state  — 2-letter code
 * @param {string} opts.apiKey
 * @param {number} [opts.limit=10]
 * @returns {Promise<Array<{ bill_number, title, status, status_label, last_action, last_action_date, sponsors, url }>>}
 */
export async function searchLegiscanBills({ query, state, apiKey, limit = 10, fetchImpl }) {
  if (!apiKey || !query?.trim() || !state) return [];
  const params = new URLSearchParams({
    key: apiKey,
    op: 'search',
    state: state.toUpperCase(),
    query: query.trim(),
  });
  let res;
  try {
    res = await fetchWithTimeout(`${LEGISCAN_BASE}?${params.toString()}`, {}, TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn('[legiscan] search network error:', err?.message);
    return [];
  }
  if (!res.ok) {
    console.warn(`[legiscan] search HTTP ${res.status}`);
    return [];
  }
  let data;
  try { data = await res.json(); } catch { return []; }
  if (data?.status !== 'OK') {
    console.warn('[legiscan] search non-OK status:', data?.alert?.message || data?.status);
    return [];
  }
  // Response shape: { status, searchresult: { 0: meta, 1..N: result } }
  const sr = data.searchresult || {};
  const out = [];
  for (const k of Object.keys(sr)) {
    if (k === 'summary' || k === '0') continue;
    const r = sr[k];
    if (!r || typeof r !== 'object') continue;
    out.push({
      bill_number: r.bill_number || '',
      title: r.title || '',
      status: typeof r.bill_status === 'number' ? r.bill_status : null,
      status_label: r.last_action || '',
      last_action: r.last_action || '',
      last_action_date: r.last_action_date || '',
      sponsors: [],
      url: r.url || '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the LegiScan toggle's system-prompt block — a list of
 * recent matching bills with status. The system prompt explicitly
 * tells the model NOT to conflate a bill's existence with enacted
 * law.
 */
export function buildLegiscanSystemBlock({ query, state, results }) {
  if (!results || !results.length) {
    return `## Legislative Activity (${state})\n\nLegiScan returned no recent bills matching this query in ${state}. The model should answer based on existing law and explicitly note that no current legislative activity was found.`;
  }
  const lines = [
    `## Legislative Activity (${state} — last 12 months)`,
    '',
    `These are bills retrieved from LegiScan matching the user's question. CRITICAL: a bill's existence does NOT mean it has become law. Always state each bill's current status. Do not state a bill amends a statute unless its status is "Passed/Enacted/Signed". When linking to a bill, attach its URL as a footnote-style markdown link "[N](url)" — never paste the URL as bare text in prose.`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(
      `Bill ${i + 1}: ${r.bill_number} — ${r.title}`
    );
    if (r.last_action) lines.push(`   Status: ${r.last_action}${r.last_action_date ? ` (${r.last_action_date})` : ''}`);
    if (r.url) lines.push(`   Footnote target: ${r.url}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Conservative amendment-freshness classifier. Returns a strict
 * three-bucket classification + user-facing note.
 *
 * Output shape:
 *   { classification: 'enacted'|'pending'|'clean', bills: [...], note: string|null }
 *
 *   - 'enacted'  → at least one bill with status in ENACTED_STATUSES
 *                  AND last_action_date later than `fetchedAt`. Note
 *                  warns the user the cited text may not reflect
 *                  current law.
 *   - 'pending'  → at least one bill with status in PENDING_STATUSES,
 *                  no enacted ones. Note reassures the user the
 *                  cited statute remains current good law.
 *   - 'clean'    → no relevant bills found. note=null.
 *
 * NEVER conflates pending with enacted.
 */
export async function checkStatuteAmendmentStatus({
  statuteCitation, state, fetchedAt, primaryUrl, apiKey, fetchImpl,
}) {
  // Pull just the section number out of the citation for the search.
  // e.g., "Fla. Stat. § 768.81" → "768.81"
  const m = String(statuteCitation || '').match(/§\s*([\d.\-:A-Z()]+)/);
  const sectionQuery = m ? m[1] : String(statuteCitation || '');
  if (!sectionQuery || !state || !apiKey) {
    return { classification: 'clean', bills: [], note: null };
  }

  const results = await searchLegiscanBills({
    query: sectionQuery, state, apiKey, limit: 10, fetchImpl,
  });
  if (!results.length) return { classification: 'clean', bills: [], note: null };

  const fetchedTs = fetchedAt ? new Date(fetchedAt).getTime() : 0;
  const enacted = [];
  const pending = [];

  for (const r of results) {
    const ts = r.last_action_date ? new Date(r.last_action_date).getTime() : 0;
    const isEnacted = r.status != null && ENACTED_STATUSES.has(r.status);
    const isPending = r.status != null && PENDING_STATUSES.has(r.status);
    if (isEnacted && (!fetchedTs || ts > fetchedTs)) {
      enacted.push(r);
    } else if (isPending) {
      pending.push(r);
    }
  }

  if (enacted.length) {
    const top = enacted[0];
    return {
      classification: 'enacted',
      bills: enacted,
      note: `AMENDED — bill ${top.bill_number} was enacted${top.last_action_date ? ` on ${top.last_action_date}` : ''}. The cited statute text may not reflect current law. Verify directly at ${primaryUrl || 'the official source'}.`,
    };
  }
  if (pending.length) {
    const top = pending[0];
    const yr = top.last_action_date ? top.last_action_date.slice(0, 4) : '';
    return {
      classification: 'pending',
      bills: pending,
      note: `Pending amendment — bill ${top.bill_number}${yr ? ` (${yr})` : ''} may modify this section. The cited text remains current good law; check ${primaryUrl || 'the official source'} before relying for time-sensitive matters.`,
    };
  }
  return { classification: 'clean', bills: [], note: null };
}
