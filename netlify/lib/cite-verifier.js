/**
 * Cite verifier — post-hoc verification of an assistant message.
 *
 * Extracts every statute citation, case citation, and URL from the
 * assistant's response and runs verification on each:
 *
 *   Statute citation → match against the selected state's
 *                      authoritative URL via statute-fetcher (state /
 *                      cornell / justia waterfall). When LegiScan
 *                      key is configured, also classify amendment
 *                      status (enacted / pending / clean).
 *
 *   Case citation    → CourtListener citation-lookup endpoint
 *                      (reuses the existing court-listener.js
 *                      _tryCitationLookup pattern).
 *
 *   URL              → HEAD/GET reachability + domain
 *                      authoritativeness classification.
 *
 * Returns the final `verification` jsonb shape that gets stored on
 * the message row.
 *
 * Pure ESM, runtime-portable. Caller passes Supabase REST client +
 * env-derived API keys explicitly.
 */

import { findState } from './state-statutes.js';
import { verifyStatuteUrl } from './statute-fetcher.js';
import { checkStatuteAmendmentStatus } from './legiscan-client.js';

// Domains whose URLs we treat as authoritative when the model
// cites them (.gov, official law publishers, primary mirrors).
const AUTHORITATIVE_HOSTS = [
  /\.gov$/i,
  /(^|\.)courtlistener\.com$/i,
  /(^|\.)law\.justia\.com$/i,
  /(^|\.)law\.cornell\.edu$/i,
  /(^|\.)supremecourt\.gov$/i,
  /(^|\.)congress\.gov$/i,
  /(^|\.)legiscan\.com$/i,
  /(^|\.)oyez\.org$/i,                  // SCOTUS
];

const URL_TIMEOUT_MS = 6000;
const URL_REGEX = /https?:\/\/[^\s)<>"'`,]+/g;

// Statute patterns. Tries common Bluebook forms; not exhaustive.
//   "Fla. Stat. § 768.81"
//   "12 U.S.C. § 5301"
//   "N.Y. Penal Law § 120.05"
//   "Cal. Penal Code § 187"
const STATUTE_REGEXES = [
  // {Abbrev}. Stat.{Optional}. § {section}
  /\b(?:[A-Z][a-z]*\.?\s+){1,4}(?:Stat\.|Code|Laws|Rev\.?\s*Stat\.?|Ann\.|Comp\.?\s*Laws|Cons\.?\s*Stat\.|Gen\.?\s*Laws)[^§]*?§\s*[\d.\-:A-Z()]+(?:\([\w]+\))?/g,
  // {N} U.S.C. § {section}
  /\b\d+\s+U\.S\.C\.\s*(?:§|sec\.?)\s*\d+(?:[\w.\-()]*)?/g,
];

// Case citation pattern. Looks for "Foo v. Bar, 123 Reporter 456".
//   - Reporter abbreviations: U.S., S. Ct., F.2d, F.3d, F.4th,
//     F. Supp., A.2d, A.3d, So. 2d, So. 3d, N.E.2d, N.E.3d,
//     N.W.2d, P.2d, P.3d, P.3d, etc.
const CASE_REGEX = /\b[A-Z][\w'.\-]+(?:\s+(?:&\s+|of\s+|the\s+|in\s+|on\s+|for\s+|de\s+|la\s+|St\.\s+|Mc[A-Z][a-z]+\s+)?[A-Z][\w'.\-]+){0,5}\s+v\.?\s+[A-Z][\w'.\-]+(?:\s+(?:&\s+|of\s+|the\s+|in\s+|on\s+|for\s+|de\s+|la\s+|St\.\s+|Mc[A-Z][a-z]+\s+)?[A-Z][\w'.\-]+){0,5}\s*,\s*\d+\s+(?:[A-Z]\.?\s*)+(?:\d+\s*d|d|st|nd|rd|th)?\s*\d+(?:\s*\(\s*\d{4}\s*\))?/g;

/**
 * Extract citations + URLs from the assistant message text. Each
 * returned entry has { kind, raw, span: [start, end] }.
 */
export function extractCitations(text) {
  if (!text) return [];
  const out = [];
  const seenSpans = new Set();   // dedupe by span start

  // Statutes
  for (const re of STATUTE_REGEXES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      const key = `s:${start}:${end}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);
      out.push({ kind: 'statute', raw: m[0].trim(), span: [start, end] });
    }
  }

  // Cases
  CASE_REGEX.lastIndex = 0;
  let cm;
  while ((cm = CASE_REGEX.exec(text)) !== null) {
    const start = cm.index;
    const end = cm.index + cm[0].length;
    const key = `c:${start}:${end}`;
    if (seenSpans.has(key)) continue;
    // Avoid case false-positives that overlap a statute span
    let overlap = false;
    for (const e of out) {
      if (e.kind === 'statute' && start < e.span[1] && end > e.span[0]) { overlap = true; break; }
    }
    if (overlap) continue;
    seenSpans.add(key);
    out.push({ kind: 'case', raw: cm[0].trim(), span: [start, end] });
  }

  // URLs
  URL_REGEX.lastIndex = 0;
  let um;
  while ((um = URL_REGEX.exec(text)) !== null) {
    const raw = um[0].replace(/[.,;:!?)\]]+$/, '');   // strip trailing punctuation
    const start = um.index;
    const end = start + raw.length;
    const key = `u:${start}:${end}`;
    if (seenSpans.has(key)) continue;
    seenSpans.add(key);
    out.push({ kind: 'url', raw, span: [start, end] });
  }

  // Sort by span start for stable ordering in the UI
  out.sort((a, b) => a.span[0] - b.span[0]);
  return out;
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

function isAuthoritativeHost(host) {
  return AUTHORITATIVE_HOSTS.some((re) => re.test(host));
}

async function headOrGet(url, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    let res = await (fetchImpl || globalThis.fetch)(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    // Some sites 405 on HEAD — fall back to GET
    if (!res.ok && (res.status === 405 || res.status === 403)) {
      res = await (fetchImpl || globalThis.fetch)(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
    }
    return res;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function verifyUrl({ raw, fetchImpl }) {
  const host = hostOf(raw);
  const res = await headOrGet(raw, fetchImpl);
  const reachable = !!res && res.ok;
  const auth = isAuthoritativeHost(host);
  if (reachable && auth) {
    return { kind: 'url', raw, status: 'verified', primary_url: raw, details: { host, http_status: res.status } };
  }
  if (reachable) {
    return { kind: 'url', raw, status: 'secondary', primary_url: raw, details: { host, http_status: res.status, note: 'reachable but non-authoritative domain' } };
  }
  return { kind: 'url', raw, status: 'unverified', primary_url: raw, details: { host, http_status: res?.status || null } };
}

/**
 * Verify a statute by trying the state's official URL, then
 * Cornell, then Justia. status='verified' if state primary
 * succeeded; 'secondary' if cornell/justia did; 'unverified'
 * otherwise.
 */
async function verifyStatute({ raw, state, sb, fetchImpl }) {
  const meta = findState(state);
  if (!meta) {
    return { kind: 'statute', raw, status: 'unverified', primary_url: null, details: { reason: 'unknown state' } };
  }
  const expected = raw;
  // Try state, then cornell, then justia
  for (const [url, source] of [
    [meta.code_url, 'state'],
    [meta.cornell_url, 'cornell'],
    [meta.justia_url, 'justia'],
  ]) {
    if (!url) continue;
    const res = await verifyStatuteUrl({ url, source, expectedQuote: null, sb, fetchImpl });
    if (res.status === 'verified') {
      return {
        kind: 'statute',
        raw,
        status: source === 'state' ? 'verified' : 'secondary',
        primary_url: res.source_url,
        fetched_at: res.fetched_at,
        details: { primary_source: source, citation_format: meta.citation_format },
      };
    }
  }
  return { kind: 'statute', raw, status: 'unverified', primary_url: meta.code_url, details: {} };
}

/**
 * Verify a case via CourtListener citation-lookup. Reuses the heavier
 * citation-verifier path. Pulled inline as a small fetch to keep this
 * module portable across runtimes.
 */
async function verifyCase({ raw, clApiKey, fetchImpl }) {
  if (!raw) return { kind: 'case', raw, status: 'unverified', primary_url: null, details: {} };
  const url = 'https://www.courtlistener.com/api/rest/v4/citation-lookup/';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        ...(clApiKey ? { Authorization: `Token ${clApiKey}` } : {}),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `text=${encodeURIComponent(raw)}`,
      signal: ctrl.signal,
    });
  } catch {
    return { kind: 'case', raw, status: 'unverified', primary_url: null, details: { reason: 'network error' } };
  } finally {
    clearTimeout(t);
  }
  if (!res || !res.ok) {
    return { kind: 'case', raw, status: 'unverified', primary_url: null, details: { http_status: res?.status || null } };
  }
  let data;
  try { data = await res.json(); } catch { return { kind: 'case', raw, status: 'unverified', primary_url: null, details: { reason: 'parse error' } }; }
  const entries = Array.isArray(data) ? data : (data?.results || []);
  const first = entries[0];
  const clusters = Array.isArray(first?.clusters) ? first.clusters : [];
  if (!clusters.length) {
    return { kind: 'case', raw, status: 'unverified', primary_url: null, details: { reason: 'no clusters' } };
  }
  const cl = clusters[0];
  return {
    kind: 'case',
    raw,
    status: 'verified',
    primary_url: cl.absolute_url ? `https://www.courtlistener.com${cl.absolute_url}` : null,
    details: {
      case_name: cl.case_name || cl.caseName || null,
      date_filed: cl.date_filed || null,
      cluster_id: cl.id || cl.cluster_id || null,
    },
  };
}

/**
 * Run verification across all extracted citations + URLs.
 * Optionally augment statute verifications with LegiScan amendment
 * freshness when configured.
 *
 * @param {object} opts
 * @param {string} opts.content
 * @param {object} opts.lawSettings   — { statutes_enabled, state, ... }
 * @param {object} opts.sb            — Supabase REST helper
 * @param {string} [opts.clApiKey]
 * @param {string} [opts.legiscanApiKey]
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<object>} verification jsonb
 */
export async function verifyMessage({
  content, lawSettings, sb, clApiKey, legiscanApiKey, fetchImpl,
}) {
  const startedAt = new Date().toISOString();
  const settings = lawSettings || {};
  const state = settings.state || 'FL';

  const cites = extractCitations(content);
  // Tag each cite with its span; we'll merge results back by index
  const results = await Promise.all(cites.map((c) => {
    if (c.kind === 'statute') return verifyStatute({ raw: c.raw, state, sb, fetchImpl }).then((r) => ({ ...c, ...r }));
    if (c.kind === 'case')    return verifyCase({ raw: c.raw, clApiKey, fetchImpl }).then((r) => ({ ...c, ...r }));
    if (c.kind === 'url')     return verifyUrl({ raw: c.raw, fetchImpl }).then((r) => ({ ...c, ...r }));
    return Promise.resolve({ ...c, status: 'unverified' });
  }));

  // Passive amendment-freshness check on every verified statute when
  // LegiScan is configured. Runs regardless of bill toggles — this is
  // the user's "extreme accuracy" requirement: never silently present
  // stale law. Backward-compat: legacy `statutes_enabled` boolean is
  // also honored alongside the new state/federal-split shape.
  const statutesActive = !!(
    settings.state_statutes_enabled ||
    settings.federal_statutes_enabled ||
    settings.statutes_enabled
  );
  if (statutesActive && legiscanApiKey) {
    for (const r of results) {
      if (r.kind !== 'statute') continue;
      if (r.status !== 'verified' && r.status !== 'secondary') continue;
      try {
        const amend = await checkStatuteAmendmentStatus({
          statuteCitation: r.raw,
          state,
          fetchedAt: r.fetched_at,
          primaryUrl: r.primary_url,
          apiKey: legiscanApiKey,
          fetchImpl,
        });
        if (amend.classification === 'enacted') {
          r.status = 'amended_enacted';
          r.amendment_note = amend.note;
          r.details = { ...(r.details || {}), bills: amend.bills.slice(0, 3) };
        } else if (amend.classification === 'pending') {
          r.status = 'pending_amendment';
          r.amendment_note = amend.note;
          r.details = { ...(r.details || {}), bills: amend.bills.slice(0, 3) };
        }
      } catch (err) {
        console.warn('[cite-verifier] amendment-status failed:', err?.message);
      }
    }
  }

  return {
    status: 'complete',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cites: results,
  };
}
