/**
 * GET /api/paralegal-matters-get?id=<uuid>
 *   ?include_items=1       (default true)
 *   ?include_audit=1       (default true; returns last 50 events)
 *   ?include_pending=1     (default true)
 *
 * Returns: {
 *   matter: { ...fields... },
 *   items: [{ id, item_kind, item_ref_id, item_ref_key, metadata, attached_at, attached_by }],
 *   pending_actions: [{ id, action_kind, payload, status, created_at }],
 *   recent_audit: [{ id, kind, payload, occurred_at }]
 * }
 *
 * Single round-trip everything-about-this-matter endpoint. The matter
 * detail page calls this once on load; later updates poll specific
 * sections (pending actions every 5s during a session) via their own
 * lighter endpoints.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id is required' }, 400);

  const includeItems = url.searchParams.get('include_items') !== '0';
  const includeAudit = url.searchParams.get('include_audit') !== '0';
  const includePending = url.searchParams.get('include_pending') !== '0';

  const supabase = getSupabaseAdmin();
  const { data: matter, error: mErr } = await supabase
    .from('paralegal_matters')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (mErr) return json({ error: mErr.message }, 500);
  if (!matter) return json({ error: 'matter not found' }, 404);

  // Parallel fetches for the bundled subsections
  const tasks = [];
  if (includeItems) {
    tasks.push(
      supabase
        .from('paralegal_matter_items')
        .select('*')
        .eq('matter_id', id)
        .order('attached_at', { ascending: false })
    );
  } else {
    tasks.push(Promise.resolve({ data: null }));
  }
  if (includePending) {
    tasks.push(
      supabase
        .from('paralegal_pending_actions')
        .select('*')
        .eq('matter_id', id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
    );
  } else {
    tasks.push(Promise.resolve({ data: null }));
  }
  if (includeAudit) {
    tasks.push(
      supabase
        .from('paralegal_audit_log')
        .select('*')
        .eq('matter_id', id)
        .order('occurred_at', { ascending: false })
        .limit(50)
    );
  } else {
    tasks.push(Promise.resolve({ data: null }));
  }
  const [{ data: items }, { data: pending }, { data: audit }] = await Promise.all(tasks);

  return json({
    matter,
    items: items || [],
    pending_actions: pending || [],
    recent_audit: audit || [],
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
