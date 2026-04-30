/**
 * GET /api/verify-citations-status?run_id=...
 *
 * Returns the current state of a verification run + (when complete)
 * signed download URLs for the form report and marked source.
 *
 * Auth: required. Users can only see their own runs (RLS-enforced).
 */

import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { formatCitationDisplay } from '../lib/citation-verifier/display.js';

const DOWNLOAD_URL_TTL_SECONDS = 60 * 30; // 30 minutes — long enough to download once

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  const url = new URL(req.url);
  const runId = url.searchParams.get('run_id');
  if (!runId) return json({ error: 'run_id query parameter is required' }, 400);

  const supabase = getSupabaseAdmin();

  const { data: run, error } = await supabase
    .from('verification_runs')
    .select(`
      id, user_id, file_name, file_format, style, ruleset, bluebook_edition,
      retain_text, status, status_progress, citation_count,
      flag_count_review, flag_count_nonconforming,
      existence_not_found_count, existence_uncertain_count,
      form_report_storage_path, marked_source_storage_path,
      created_at, completed_at, error_message
    `)
    .eq('id', runId)
    .maybeSingle();

  if (error)  return json({ error: error.message }, 500);
  if (!run)   return json({ error: 'Run not found' }, 404);
  if (run.user_id !== auth.user.id) return json({ error: 'Forbidden' }, 403);

  // Sign the output URLs (only when complete).
  let formReportUrl = null;
  let markedSourceUrl = null;
  if (run.status === 'complete') {
    if (run.form_report_storage_path) {
      const { data, error: signErr } = await supabase.storage
        .from('citation-verifier-output')
        .createSignedUrl(run.form_report_storage_path, DOWNLOAD_URL_TTL_SECONDS);
      if (!signErr) formReportUrl = data?.signedUrl || null;
    }
    if (run.marked_source_storage_path) {
      const { data, error: signErr } = await supabase.storage
        .from('citation-verifier-output')
        .createSignedUrl(run.marked_source_storage_path, DOWNLOAD_URL_TTL_SECONDS);
      if (!signErr) markedSourceUrl = data?.signedUrl || null;
    }
  }

  // Optionally pull the per-citation list when complete (for the results UI).
  let citations = null;
  if (run.status === 'complete' && url.searchParams.get('include_citations') === '1') {
    const { data: cs } = await supabase
      .from('citations')
      .select(`
        id, candidate_text, char_start, char_end, page_number, in_footnote, footnote_num,
        citation_type, components, governing_rule, governing_table,
        existence_status, courtlistener_url, courtlistener_search_url,
        flags ( id, severity, category, rule_cite, table_cite, message, suggested_fix )
      `)
      .eq('run_id', run.id)
      .order('char_start', { ascending: true });
    // Annotate each citation with a display-ready string. When retain_text
    // is off (privilege default), candidate_text is null in the DB; the
    // formatter rebuilds the citation from components so the UI still
    // shows something readable. When retain_text is on, candidate_text is
    // used verbatim.
    citations = (cs || []).map((c) => ({
      ...c,
      display_text: formatCitationDisplay(c),
    }));
  }

  return json({
    ok: true,
    run: {
      ...run,
      form_report_url: formReportUrl,
      marked_source_url: markedSourceUrl,
    },
    citations,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
