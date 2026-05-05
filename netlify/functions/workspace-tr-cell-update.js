/**
 * POST /api/workspace-tr-cell-update
 *   body:
 *     single:  { id, redline_status }
 *     bulk by review: { review_id, document_id?, redline_status, scope?: 'all' | 'pending' }
 *
 * Sets the redline_status (accepted/rejected/pending) on a cell or
 * group of cells in a redline-mode tabular review. Owner-only.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID = new Set(['accepted', 'rejected', 'pending']);

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const status = String(body.redline_status || '');
  if (!VALID.has(status)) return json({ error: 'Invalid redline_status' }, 400);
  const resolvedAt = status === 'pending' ? null : new Date().toISOString();

  const supabase = getSupabaseAdmin();
  const patch = { redline_status: status, redline_resolved_at: resolvedAt };

  if (body.review_id) {
    // Verify review ownership
    const { data: review } = await supabase
      .from('workspace_tabular_reviews')
      .select('id, user_id')
      .eq('id', body.review_id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!review) return json({ error: 'Review not found' }, 404);

    let q = supabase.from('workspace_tabular_cells').update(patch).eq('review_id', body.review_id);
    if (body.document_id) q = q.eq('document_id', body.document_id);
    if (body.scope === 'pending') q = q.eq('redline_status', 'pending');
    // Only update cells with a redline_find (otherwise it's an extraction cell)
    q = q.not('redline_find', 'is', null);
    const { error, count } = await q.select('id', { count: 'exact' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated: count ?? 0 });
  }

  if (!body.id) return json({ error: 'Missing id or review_id' }, 400);

  // Single — verify ownership via the parent review
  const { data: cell } = await supabase
    .from('workspace_tabular_cells')
    .select('id, review_id')
    .eq('id', body.id)
    .maybeSingle();
  if (!cell) return json({ error: 'Cell not found' }, 404);
  const { data: review } = await supabase
    .from('workspace_tabular_reviews')
    .select('id')
    .eq('id', cell.review_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!review) return json({ error: 'Cell not found' }, 404);

  const { error } = await supabase
    .from('workspace_tabular_cells')
    .update(patch)
    .eq('id', body.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: 1 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
