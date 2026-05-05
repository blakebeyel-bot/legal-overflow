/**
 * GET /api/workspace-compare-list?project_id=<uuid>
 * Returns: { runs: [...] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');

  let q = supabase
    .from('workspace_compare_runs')
    .select(`
      id, title, status, status_detail, diffs_count, summary, client_role,
      base_document_id, proposed_document_id, created_at, updated_at,
      base_document:base_document_id (filename),
      proposed_document:proposed_document_id (filename)
    `)
    .eq('user_id', auth.user.id)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (projectId === 'null' || projectId === '') q = q.is('project_id', null);
  else if (projectId) q = q.eq('project_id', projectId);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ runs: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
