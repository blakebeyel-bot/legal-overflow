/**
 * POST /api/workspace-projects-update
 *   body: { id, name?, description?, archived?: boolean }
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
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 200);
  if (typeof body.description === 'string') patch.description = body.description.slice(0, 2000);
  if ('archived' in body) patch.archived_at = body.archived ? new Date().toISOString() : null;
  if (Object.keys(patch).length === 0) return json({ ok: true });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_projects')
    .update(patch)
    .eq('id', body.id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
