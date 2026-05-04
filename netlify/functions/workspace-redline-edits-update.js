/**
 * POST /api/workspace-redline-edits-update
 *   body:
 *     single:  { id, status }
 *     bulk:    { ids: [...], status }
 *     all:     { run_id, status, scope: 'all' | 'pending' }
 *
 * Status must be 'accepted' | 'rejected' | 'pending'.
 *
 * The bulk and all forms let the user accept/reject everything in a
 * run with one click — useful when the LLM proposed 20 edits and the
 * user agrees with most of them.
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
  const status = String(body.status || '');
  if (!VALID.has(status)) return json({ error: 'Invalid status' }, 400);
  const resolvedAt = status === 'pending' ? null : new Date().toISOString();
  const supabase = getSupabaseAdmin();

  // Bulk by run_id + scope
  if (body.run_id) {
    // Verify ownership
    const { data: run } = await supabase
      .from('workspace_redline_runs')
      .select('id, user_id')
      .eq('id', body.run_id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!run) return json({ error: 'Run not found' }, 404);

    let q = supabase.from('workspace_redline_edits')
      .update({ status, resolved_at: resolvedAt })
      .eq('run_id', body.run_id);
    if (body.scope === 'pending') q = q.eq('status', 'pending');
    const { error, count } = await q.select('id', { count: 'exact' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated: count ?? 0 });
  }

  // Bulk by ids
  if (Array.isArray(body.ids) && body.ids.length) {
    // Defensive: confirm all ids belong to runs owned by this user
    const { data: editRows } = await supabase
      .from('workspace_redline_edits')
      .select('id, run_id')
      .in('id', body.ids);
    const runIds = Array.from(new Set((editRows || []).map((r) => r.run_id)));
    const { data: ownedRuns } = await supabase
      .from('workspace_redline_runs')
      .select('id')
      .in('id', runIds)
      .eq('user_id', auth.user.id);
    const ownedRunIdSet = new Set((ownedRuns || []).map((r) => r.id));
    const validEditIds = (editRows || []).filter((r) => ownedRunIdSet.has(r.run_id)).map((r) => r.id);
    if (validEditIds.length === 0) return json({ error: 'No matching edits' }, 404);

    const { error } = await supabase
      .from('workspace_redline_edits')
      .update({ status, resolved_at: resolvedAt })
      .in('id', validEditIds);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated: validEditIds.length });
  }

  // Single id
  if (!body.id) return json({ error: 'Missing id / ids / run_id' }, 400);
  const { data: edit } = await supabase
    .from('workspace_redline_edits')
    .select('id, run_id')
    .eq('id', body.id)
    .maybeSingle();
  if (!edit) return json({ error: 'Edit not found' }, 404);
  // Verify run ownership
  const { data: run } = await supabase
    .from('workspace_redline_runs')
    .select('id')
    .eq('id', edit.run_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!run) return json({ error: 'Edit not found' }, 404);

  const { error } = await supabase
    .from('workspace_redline_edits')
    .update({ status, resolved_at: resolvedAt })
    .eq('id', body.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: 1 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
