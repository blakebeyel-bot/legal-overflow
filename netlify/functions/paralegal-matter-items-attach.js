/**
 * POST /api/paralegal-matter-items-attach
 *   body: {
 *     matter_id: uuid (required),
 *     item_kind: 'vault_item'|'library_document'|'chat'|'email_thread'|
 *                'calendar_event'|'redline_run'|'compare_run'|'tr_review'|
 *                'citation_run'|'manual_note',
 *     item_ref_id?: uuid,
 *     item_ref_key?: string,           (for email_thread / calendar_event)
 *     metadata?: object,
 *     attached_by?: 'user'|'agent'     (default 'user')
 *   }
 *
 * Idempotent: re-attaching the same item to the same matter is a no-op
 * (returns the existing row). The unique constraint on
 * (matter_id, item_kind, coalesce(item_ref_id, item_ref_key)) enforces this
 * at the DB level; we catch the conflict and return the existing row.
 *
 * Returns: { item, created: boolean }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_KINDS = new Set([
  'vault_item', 'library_document', 'chat', 'email_thread',
  'calendar_event', 'redline_run', 'compare_run', 'tr_review',
  'citation_run', 'manual_note',
]);

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { matter_id, item_kind, item_ref_id, item_ref_key, metadata, attached_by } = body || {};

  if (!matter_id) return json({ error: 'matter_id is required' }, 400);
  if (!VALID_KINDS.has(item_kind)) return json({ error: `Invalid item_kind: ${item_kind}` }, 400);
  if (!item_ref_id && !item_ref_key) {
    return json({ error: 'item_ref_id or item_ref_key is required' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // Verify the matter belongs to the user (RLS would catch it later, but
  // an explicit check gives a cleaner error).
  const { data: matter, error: mErr } = await supabase
    .from('paralegal_matters')
    .select('id')
    .eq('id', matter_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (mErr) return json({ error: mErr.message }, 500);
  if (!matter) return json({ error: 'matter not found' }, 404);

  const row = {
    matter_id,
    user_id: auth.user.id,
    item_kind,
    item_ref_id: item_ref_id || null,
    item_ref_key: item_ref_key || null,
    metadata: metadata || {},
    attached_by: attached_by === 'agent' ? 'agent' : (attached_by === 'system' ? 'system' : 'user'),
  };

  // Try insert; on unique-violation, return the existing row.
  const { data: inserted, error: insErr } = await supabase
    .from('paralegal_matter_items')
    .insert(row)
    .select('*')
    .single();

  if (insErr) {
    // 23505 = unique_violation in Postgres
    if (insErr.code === '23505') {
      const refExpr = item_ref_id ? `item_ref_id.eq.${item_ref_id}` : `item_ref_key.eq.${item_ref_key}`;
      const { data: existing } = await supabase
        .from('paralegal_matter_items')
        .select('*')
        .eq('matter_id', matter_id)
        .eq('item_kind', item_kind)
        .or(refExpr)
        .maybeSingle();
      if (existing) return json({ item: existing, created: false });
    }
    return json({ error: insErr.message }, 500);
  }

  return json({ item: inserted, created: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
