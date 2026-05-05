/**
 * GET /api/workspace-compare-get?id=<run_id>
 * Returns: { run, diffs, base_document, proposed_document }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: run, error } = await supabase
    .from('workspace_compare_runs')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!run) return json({ error: 'Run not found' }, 404);

  const { data: diffs } = await supabase
    .from('workspace_compare_diffs')
    .select('*')
    .eq('run_id', id)
    .order('diff_index', { ascending: true });

  const { data: docs } = await supabase
    .from('workspace_documents')
    .select('id, filename, file_type, original_filename')
    .in('id', [run.base_document_id, run.proposed_document_id]);
  const base_document = docs?.find((d) => d.id === run.base_document_id) || null;
  const proposed_document = docs?.find((d) => d.id === run.proposed_document_id) || null;

  return json({ run, diffs: diffs || [], base_document, proposed_document });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
