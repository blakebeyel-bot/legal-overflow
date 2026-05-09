/**
 * POST /api/workspace-vault-delete
 *   body: { id, hard?: boolean }
 *
 * Soft delete (default) sets archived_at. Hard delete (hard=true)
 * removes the row entirely; chunks cascade.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'POST/DELETE only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const id = body.id;
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();

  if (body.hard === true) {
    const { error } = await supabase
      .from('workspace_vault_items')
      .delete()
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, deleted: 'hard' });
  }

  const { error } = await supabase
    .from('workspace_vault_items')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, deleted: 'soft' });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
