/**
 * GET /api/agents-stats
 *
 * Public, no-auth endpoint that returns site-wide aggregate stats for the
 * agents index hero. Returns totals and percentile latency across BOTH
 * agents (citation verifier + contract review). Cached 5 minutes — these
 * are vanity / marketing numbers, not real-time dashboards, so we don't
 * need second-level freshness.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     stats: {
 *       runs_30d:           number,    // runs across both agents in last 30 days
 *       median_completion_s: number,   // p50 completion time in seconds
 *       findings_raised:    number,    // citations checked + contract findings
 *       false_positive_pct: number|null
 *     }
 *   }
 *
 * Privacy: only aggregate counts are exposed. No user IDs, no document
 * names, no per-row data.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;

export default async (req, ctx) => {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);

  // Serve from cache when fresh — these aggregates change slowly and the
  // index page hits this endpoint on every page load.
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return json({ ok: true, stats: _cache.stats, cached: true });
  }

  const supabase = getSupabaseAdmin();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ---- Citation Verifier aggregates ----------------------------------
  const verifierAgg = { runs: 0, durations: [], findings: 0 };
  try {
    const { data: vRuns } = await supabase
      .from('verification_runs')
      .select('status, citation_count, started_at, completed_at, created_at')
      .gte('created_at', since30d);
    for (const r of (vRuns || [])) {
      verifierAgg.runs++;
      if (r.status === 'complete' && r.completed_at && (r.started_at || r.created_at)) {
        const t0 = new Date(r.started_at || r.created_at).getTime();
        const t1 = new Date(r.completed_at).getTime();
        const secs = Math.max(0, (t1 - t0) / 1000);
        if (secs > 0 && secs < 7200) verifierAgg.durations.push(secs);
      }
      verifierAgg.findings += (r.citation_count || 0);
    }
  } catch (err) {
    console.warn('[agents-stats] verifier aggregate failed:', err?.message);
  }

  // ---- Contract Review aggregates ------------------------------------
  const reviewAgg = { runs: 0, durations: [], findings: 0 };
  try {
    const { data: cRuns } = await supabase
      .from('reviews')
      .select('status, severity_counts, created_at, completed_at')
      .gte('created_at', since30d);
    for (const r of (cRuns || [])) {
      reviewAgg.runs++;
      if (r.status === 'complete' && r.completed_at && r.created_at) {
        const t0 = new Date(r.created_at).getTime();
        const t1 = new Date(r.completed_at).getTime();
        const secs = Math.max(0, (t1 - t0) / 1000);
        if (secs > 0 && secs < 7200) reviewAgg.durations.push(secs);
      }
      const sc = r.severity_counts || {};
      reviewAgg.findings +=
        (sc.blocker || 0) + (sc.major || 0) + (sc.moderate || 0) + (sc.minor || 0);
    }
  } catch (err) {
    console.warn('[agents-stats] review aggregate failed:', err?.message);
  }

  // ---- Combine -------------------------------------------------------
  const allDurations = [...verifierAgg.durations, ...reviewAgg.durations].sort((a, b) => a - b);
  const medianCompletionSec = allDurations.length
    ? Math.round(allDurations[Math.floor(allDurations.length / 2)])
    : null;

  // False-positive % isn't tracked in the schema — there is no per-finding
  // user-feedback table yet. Return null so the frontend can hide / dim
  // that stat instead of inventing a number. When we add a feedback table
  // (e.g. workspace_finding_feedback with accepted/rejected), this is the
  // place to compute it.
  const stats = {
    runs_30d: verifierAgg.runs + reviewAgg.runs,
    median_completion_s: medianCompletionSec,
    findings_raised: verifierAgg.findings + reviewAgg.findings,
    false_positive_pct: null,
  };

  _cache = { at: Date.now(), stats };
  return json({ ok: true, stats });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300', // 5 min CDN cache too
    },
  });
}
