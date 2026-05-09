/**
 * GET /api/workspace-vault-get?id=<uuid>
 *
 * Returns a single vault item with full content and chunk count.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: item, error } = await supabase
    .from('workspace_vault_items')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!item) return json({ error: 'Not found' }, 404);

  const { count: chunkCount } = await supabase
    .from('workspace_vault_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('item_id', id);

  return json({ item, chunk_count: chunkCount ?? 0 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
