/**
 * POST /api/paralegal-matters-archive
 *   body: { id: uuid, restore?: boolean }
 *
 * Soft-deletes a matter by setting archived_at. Pass restore: true to
 * un-archive (clears archived_at). Matter items + audit log are preserved
 * but the matter no longer appears in default lists.
 *
 * Returns: { ok: true, matter }
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
  const { id, restore } = body || {};
  if (!id) return json({ error: 'id is required' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: matter, error } = await supabase
    .from('paralegal_matters')
    .update({ archived_at: restore ? null : new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);
  if (!matter) return json({ error: 'matter not found' }, 404);

  await supabase.from('paralegal_audit_log').insert({
    user_id: auth.user.id,
    matter_id: id,
    kind: 'system',
    payload: { event: restore ? 'matter_restored' : 'matter_archived' },
  });

  return json({ ok: true, matter });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
