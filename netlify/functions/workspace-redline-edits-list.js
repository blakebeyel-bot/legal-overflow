/**
 * GET /api/workspace-redline-edits-list?run_id=<uuid>
 * Returns: { edits: [...] } in original LLM-output order.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const runId = new URL(req.url).searchParams.get('run_id');
  if (!runId) return json({ error: 'Missing run_id' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership of the run
  const { data: run } = await supabase
    .from('workspace_redline_runs')
    .select('id, user_id')
    .eq('id', runId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!run) return json({ error: 'Run not found' }, 404);

  const { data: edits, error } = await supabase
    .from('workspace_redline_edits')
    .select('*')
    .eq('run_id', runId)
    .order('edit_index', { ascending: true });
  if (error) return json({ error: error.message }, 500);

  return json({ edits: edits || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
