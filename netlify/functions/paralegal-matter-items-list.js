/**
 * GET /api/paralegal-matter-items-list
 *   ?matter_id=<uuid> (required)
 *   ?kind=<item_kind>  (optional filter)
 *
 * Returns: { items: [{ id, matter_id, item_kind, item_ref_id, item_ref_key, metadata, attached_at, attached_by }] }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const matter_id = url.searchParams.get('matter_id');
  const kind = url.searchParams.get('kind');
  if (!matter_id) return json({ error: 'matter_id is required' }, 400);

  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('paralegal_matter_items')
    .select('*')
    .eq('matter_id', matter_id)
    .eq('user_id', auth.user.id)
    .order('attached_at', { ascending: false });
  if (kind) q = q.eq('item_kind', kind);

  const { data: items, error } = await q;
  if (error) return json({ error: error.message }, 500);

  return json({ items: items || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
