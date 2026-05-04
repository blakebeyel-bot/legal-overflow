/**
 * POST /api/workspace-chats-create
 *   body: { project_id?: uuid, model?: string }
 * Returns: { id }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_chats')
    .insert({
      user_id: auth.user.id,
      project_id: body.project_id || null,
      model: body.model || 'claude-sonnet-4-5',
    })
    .select('id')
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ id: data.id });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
