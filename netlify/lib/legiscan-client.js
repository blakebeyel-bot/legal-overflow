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
 * LegiScan numeric status codes (per User Manual v1.91, p. 42):
 *   0 N/A (pre-filed/pre-introduction)
 *   1 Introduced
 *   2 Engrossed       (passed origin chamber)
 *   3 Enrolled        (passed both chambers, awaiting governor)
 *   4 Passed          (signed/enacted)
 *   5 Vetoed
 *   6 Failed
 *   7 Override        (veto override = enacted)
 *   8 Chaptered       (Progress array only — codified)
 *
 * NOTE: getSearch responses do NOT include the numeric `status` field;
 * only getBill does. We therefore classify enactment by parsing the
 * `last_action` text, which all search results carry. To confirm a
 * top-hit enactment we'd need a follow-up getBill — a future
 * optimization, since each call counts against the 30k/month quota.
 */
const ENACTED_STATUSES = new Set([4, 7, 8]);
const PENDING_STATUSES = new Set([1, 2, 3]);

// Last-action text → bucket. Tuned for low false-positive rate.
// "Passed" alone (e.g. "Third Reading Passed (46-0)") is a chamber
// vote, NOT enactment, and stays in the pending bucket.
const ENACTED_RE = /\b(signed by (?:the )?(?:governor|president)|approved by (?:the )?(?:governor|president)|became (?:public )?law|public law|public act|act no\.?|chaptered|enacted into law|effective\s+(?:date\s+)?\d)/i;
const FAILED_RE = /\b(veto(?:ed)?|failed|defeated|died(?:\s+in)?|withdrawn|recalled|indefinitely postponed|adjourned sine die)\b/i;

function classifyLastAction(text) {
  const s = String(text || '');
  if (ENACTED_RE.test(s)) return 'enacted';
  if (FAILED_RE.test(s)) return 'failed';
  return 'pending';   // any other live state — introduced, referred, read, engrossed, enrolled, chamber-passed, etc.
}

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
  // Per User Manual v1.91 (p. 21):
  //   https://api.legiscan.com/?key=APIKEY&op=getSearch&state=STATE&query=QUERY
  // year=2 = current year (default, but explicit for clarity).
  const params = new URLSearchParams({
    key: apiKey,
    op: 'getSearch',
    state: state.toUpperCase(),
    query: query.trim(),
    year: '2',
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
  // Response shape (v1.91, p. 22):
  //   { status: "OK", searchresult: { summary: {...}, "0": {...}, "1": {...}, ... } }
  // The numeric-keyed entries (starting at "0") are the actual
  // results, sorted by relevance descending. Only "summary" is meta.
  const sr = data.searchresult || {};
  const numericKeys = Object.keys(sr)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  const out = [];
  for (const k of numericKeys) {
    const r = sr[k];
    if (!r || typeof r !== 'object') continue;
    out.push({
      bill_id: typeof r.bill_id === 'number' ? r.bill_id : null,
      bill_number: r.bill_number || '',
      title: r.title || '',
      // getSearch does NOT return the numeric `status` field — only
      // getBill does. We expose the parsed last-action bucket so
      // callers can classify without an extra API call.
      last_action: r.last_action || '',
      last_action_date: r.last_action_date || '',
      action_class: classifyLastAction(r.last_action),
      relevance: typeof r.relevance === 'number' ? r.relevance : null,
      state: r.state || '',
      sponsors: [],
      url: r.url || '',
      change_hash: r.change_hash || '',
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
    const cls = r.action_class;
    if (cls === 'failed') continue;     // vetoed / dead bills don't change the statute
    if (cls === 'enacted' && (!fetchedTs || ts > fetchedTs)) {
      enacted.push(r);
    } else if (cls === 'pending') {
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
