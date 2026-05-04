/**
 * GET /api/workspace-chats-list
 *   ?project_id=<uuid>   — optional, filters to a project
 *   ?limit=50            — default 50, max 200
 *
 * Returns the signed-in user's chats sorted by updated_at desc.
 * Approval-gated (every workspace endpoint is).
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('workspace_chats')
    .select('id, title, model, project_id, created_at, updated_at')
    .eq('user_id', auth.user.id)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (projectId === 'null' || projectId === '') q = q.is('project_id', null);
  else if (projectId) q = q.eq('project_id', projectId);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ chats: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
