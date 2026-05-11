/**
 * POST /api/paralegal-matter-items-detach
 *   body: { id: uuid }                  // matter_item row id
 *
 * Removes the link only; the underlying item (vault doc, chat, etc.) is
 * untouched.
 *
 * Returns: { ok: true }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { id } = body || {};
  if (!id) return json({ error: 'id is required' }, 400);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('paralegal_matter_items')
    .delete()
    .eq('id', id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
