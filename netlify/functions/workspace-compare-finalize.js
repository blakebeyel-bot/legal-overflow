/**
 * POST /api/workspace-compare-finalize
 *   body: { id }   — the compare run id
 * Returns: { ok: true }   immediately; the work runs in the background
 *                          function (workspace-compare-finalize-background).
 *                          The UI polls workspace-compare-get for status
 *                          flipping from 'finalizing' → 'complete' and
 *                          finalized_version_id becoming non-null.
 *
 * What "finalizing" produces: a redline deliverable in the same format
 * as the proposed (counterparty) document — tracked-changes .docx for
 * DOCX inputs, inline-strikethrough+insertion .pdf for PDF inputs (via
 * the Modal/PyMuPDF service), plus an always-generated markdown
 * negotiation-summary memo on workspace_compare_runs.summary_md.
 *
 * Idempotency: if the run is already finalized (status='complete' AND
 * finalized_version_id is set), this returns ok without re-running. To
 * regenerate, the user can change a user_choice and click Finalize
 * again — the row's diffs_count + accumulated state will be different.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const id = body.id;
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  // Verify ownership before triggering the background job. Defense in
  // depth — the background also re-verifies, but failing fast here
  // saves a round-trip.
  const { data: run, error } = await supabase
    .from('workspace_compare_runs')
    .select('id, user_id, status, finalized_version_id, base_document_id, proposed_document_id')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!run) return json({ error: 'Run not found' }, 404);
  if (run.status !== 'complete') {
    return json({ error: 'Compare run must be complete before finalizing' }, 409);
  }

  // Mark as finalizing so the UI poll picks up the transition. The
  // background flips status back to 'complete' on success or 'error'
  // on failure (with a status_detail message for the UI).
  await supabase.from('workspace_compare_runs')
    .update({ status: 'finalizing', status_detail: 'Building redline deliverable…' })
    .eq('id', id);

  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  fetch(`${base}/.netlify/functions/workspace-compare-finalize-background`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Trigger': 'compare-finalize',
    },
    body: JSON.stringify({ run_id: id, user_id: auth.user.id }),
  }).catch((err) => console.error('compare finalize fanout fire failed:', err.message));

  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
