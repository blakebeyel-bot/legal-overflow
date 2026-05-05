/**
 * POST /api/workspace-compare-diff-update
 *   body:
 *     single:  { id, user_choice, user_custom_text? }
 *     bulk:    { run_id, user_choice, scope?: 'all' | 'pending' | 'recommended' }
 *
 * user_choice ∈ 'pending' | 'accept_proposed' | 'keep_base' | 'custom'
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID = new Set(['pending', 'accept_proposed', 'keep_base', 'custom']);

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const choice = String(body.user_choice || '');
  if (!VALID.has(choice)) return json({ error: 'Invalid user_choice' }, 400);
  const resolvedAt = choice === 'pending' ? null : new Date().toISOString();

  const supabase = getSupabaseAdmin();

  if (body.run_id) {
    // Verify ownership
    const { data: run } = await supabase
      .from('workspace_compare_runs')
      .select('id')
      .eq('id', body.run_id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!run) return json({ error: 'Run not found' }, 404);

    let q = supabase.from('workspace_compare_diffs')
      .update({ user_choice: choice, resolved_at: resolvedAt })
      .eq('run_id', body.run_id);
    if (body.scope === 'pending') q = q.eq('user_choice', 'pending');
    if (body.scope === 'recommended') {
      // Bulk-apply the model's recommendation: accept→accept_proposed, reject→keep_base, negotiate→pending (user must decide)
      // Implemented client-side per row instead — fall back to no-op here
      return json({ error: 'scope=recommended must be applied per-row' }, 400);
    }
    const { error, count } = await q.select('id', { count: 'exact' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated: count ?? 0 });
  }

  if (!body.id) return json({ error: 'Missing id or run_id' }, 400);

  // Single — verify via parent run ownership
  const { data: diff } = await supabase
    .from('workspace_compare_diffs')
    .select('id, run_id')
    .eq('id', body.id)
    .maybeSingle();
  if (!diff) return json({ error: 'Diff not found' }, 404);
  const { data: run } = await supabase
    .from('workspace_compare_runs')
    .select('id')
    .eq('id', diff.run_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!run) return json({ error: 'Diff not found' }, 404);

  const patch = { user_choice: choice, resolved_at: resolvedAt };
  if (typeof body.user_custom_text === 'string') patch.user_custom_text = body.user_custom_text.slice(0, 4000);
  const { error } = await supabase
    .from('workspace_compare_diffs')
    .update(patch)
    .eq('id', body.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated: 1 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
