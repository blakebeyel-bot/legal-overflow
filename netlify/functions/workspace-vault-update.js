/**
 * POST /api/workspace-vault-update
 *   body: { id, title?, summary?, tags?, pinned?, archived? }
 *
 * Edits metadata on a vault item. Does NOT re-embed; content edits
 * would require chunk regeneration so we explicitly disallow editing
 * `content` here. (To replace content the user can delete and re-add.)
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const id = body.id;
  if (!id) return json({ error: 'Missing id' }, 400);

  const patch = {};
  if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 500);
  if (typeof body.summary === 'string') patch.summary = body.summary.slice(0, 2000);
  if (Array.isArray(body.tags)) patch.tags = body.tags.slice(0, 32).map((t) => String(t).slice(0, 80));
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  if (typeof body.archived === 'boolean') {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: 'Nothing to update' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_vault_items')
    .update(patch)
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('*')
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'Not found' }, 404);
  return json({ item: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
