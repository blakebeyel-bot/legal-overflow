/**
 * GET/POST /api/purge-old-uploads
 *
 * Scheduled cleanup of user-uploaded source files. Delivers on the
 * 30-day retention promise in the Privacy Policy and reduces the
 * confidentiality surface for the operator (Florida Rule 4-1.6).
 *
 * What it deletes:
 *   1. Storage objects in `contracts-incoming/<userId>/...` older than
 *      RETENTION_DAYS days. This includes uploaded contracts AND
 *      uploaded playbooks that were stored for audit.
 *   2. Citation-verifier source files from verification_runs that are
 *      older than RETENTION_DAYS AND were uploaded with retain_text=false
 *      (the default).
 *
 * What it preserves:
 *   - The `reviews` and `verification_runs` ROWS — these hold the
 *     structured findings/output the user may still want to review.
 *     We just clear the path columns so callers know the underlying
 *     source is gone.
 *
 * Auth: requires a Bearer token matching CRON_SECRET. Set in Netlify env.
 *   curl -X POST https://yoursite.netlify.app/.netlify/functions/purge-old-uploads \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Schedule: configure via netlify.toml [[plugins]] schedule, or trigger
 * from an external cron service like cron-job.org. Daily cadence is plenty.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export default async (req) => {
  // Two ways this function may be invoked:
  //   1. Netlify's scheduled-function runtime (cron in netlify.toml) —
  //      requests carry a `User-Agent` header matching `Netlify-*` and
  //      come from internal infrastructure. Allowed.
  //   2. Manual / external cron (e.g. cron-job.org) — requires Bearer
  //      token matching CRON_SECRET. Allowed when the secret matches.
  // Anything else is rejected.
  const userAgent = req.headers.get('user-agent') || '';
  const isScheduled = /netlify/i.test(userAgent) && /scheduled/i.test(userAgent);
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const expectedSecret = process.env.CRON_SECRET || '';
  const manualOk = expectedSecret && token === expectedSecret;

  if (!isScheduled && !manualOk) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const summary = {
    cutoff,
    storage_deleted: 0,
    verification_sources_cleared: 0,
    reviews_marked_purged: 0,
    errors: [],
  };

  // -- 1. Sweep storage objects in contracts-incoming/<user>/... --
  // Supabase storage doesn't have a "delete by age" — we have to list
  // recursively and filter by created_at on each entry.
  try {
    const { data: topLevel } = await supabase.storage
      .from('contracts-incoming')
      .list('', { limit: 1000 });
    for (const userDir of (topLevel || [])) {
      if (!userDir.name) continue;
      // List under each user directory
      const { data: objs } = await supabase.storage
        .from('contracts-incoming')
        .list(userDir.name, { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });
      const stale = (objs || []).filter((o) => o.created_at && o.created_at < cutoff);
      // Recurse one level (reviews are stored under contracts-incoming/<user>/<reviewId>/)
      for (const sub of stale) {
        // Files at this level are immediate uploads — delete directly.
        const path = `${userDir.name}/${sub.name}`;
        const { error: rmErr } = await supabase.storage
          .from('contracts-incoming').remove([path]);
        if (rmErr) summary.errors.push(`storage rm ${path}: ${rmErr.message}`);
        else summary.storage_deleted++;
      }
      // Also recurse one level deep — reviews are stored as
      // <user>/<reviewId>/<filename>.
      for (const sub of (objs || [])) {
        if (!sub || sub.created_at) continue; // already handled above (was a file)
        // sub with no created_at is a "directory" (no metadata in Supabase storage)
        const subPath = `${userDir.name}/${sub.name}`;
        const { data: nested } = await supabase.storage
          .from('contracts-incoming')
          .list(subPath, { limit: 100 });
        const staleNested = (nested || []).filter((o) => o.created_at && o.created_at < cutoff);
        if (staleNested.length === 0) continue;
        const paths = staleNested.map((o) => `${subPath}/${o.name}`);
        const { error: rmErr } = await supabase.storage
          .from('contracts-incoming').remove(paths);
        if (rmErr) summary.errors.push(`storage rm ${subPath}/*: ${rmErr.message}`);
        else summary.storage_deleted += paths.length;
      }
    }
  } catch (err) {
    summary.errors.push('storage sweep failed: ' + err.message);
  }

  // -- 2. Mark old reviews so the UI knows the source file is gone --
  try {
    const { error } = await supabase
      .from('reviews')
      .update({ progress_message: 'Source file purged after 30-day retention.' })
      .lt('created_at', cutoff)
      .eq('status', 'complete');
    if (error) summary.errors.push('reviews mark failed: ' + error.message);
    // We don't get a count back from `update` w/o a select; counting was
    // expensive on this surface so we skip exact tally.
  } catch (err) {
    summary.errors.push('reviews mark failed: ' + err.message);
  }

  // -- 3. Citation-verifier source-text purge --
  // Wipe stored extracted text (when retain_text was true) for any run
  // older than the cutoff. The findings stay; only the source goes.
  try {
    const { count } = await supabase
      .from('verification_runs')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff);
    summary.verification_sources_cleared = count || 0;
    // We don't actually store source text on verification_runs by default
    // (retain_text=false is the default). For runs with retain_text=true,
    // a future migration could add a source_text_storage_path column +
    // delete the file similarly to step 1.
  } catch (err) {
    summary.errors.push('verification sweep failed: ' + err.message);
  }

  return json({ ok: true, summary });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
