/**
 * GET /api/workspace-tr-list
 *   ?project_id=<uuid>
 * Returns: { reviews: [...] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');

  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('workspace_tabular_reviews')
    .select('id, title, status, status_detail, model, columns_config, created_at, updated_at')
    .eq('user_id', auth.user.id)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (projectId === 'null' || projectId === '') q = q.is('project_id', null);
  else if (projectId) q = q.eq('project_id', projectId);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ reviews: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
