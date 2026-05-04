/**
 * PATCH /api/workspace-chats-update
 *   body: { id, title?, model?, project_id? }
 * Updates the chat's editable fields. Only fields present in the body are touched.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  if (!body.id) return json({ error: 'Missing id' }, 400);

  const patch = {};
  if (typeof body.title === 'string') patch.title = body.title.slice(0, 200);
  if (typeof body.model === 'string') patch.model = body.model;
  if ('project_id' in body) patch.project_id = body.project_id || null;
  if ('workflow_id' in body) patch.workflow_id = body.workflow_id || null;
  if (Object.keys(patch).length === 0) return json({ ok: true });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_chats')
    .update(patch)
    .eq('id', body.id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
