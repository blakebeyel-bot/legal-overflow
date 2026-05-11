/**
 * GET /api/paralegal-matters-list
 *   ?status=active|watching|closed    (default 'active')
 *   ?group=due-this-week|due-this-month|all   (default 'all')
 *   ?include_archived=1                (rare)
 *   ?q=<search string>                 (matches client + counter_party)
 *
 * Returns: { matters: [{ id, client, counter_party, stage, status, response_due, ...counts }] }
 *
 * Powers the /agents/paralegal/matters/ table. Includes lightweight per-row
 * counts (linked items, pending actions, recent audit events) so the UI can
 * render badges without an N+1 round-trip.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_STATUSES = new Set(['active', 'watching', 'closed']);

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') || 'active';
  const group = url.searchParams.get('group') || 'all';
  const includeArchived = url.searchParams.get('include_archived') === '1';
  const q = (url.searchParams.get('q') || '').trim();

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('paralegal_matters')
    .select('*')
    .eq('user_id', auth.user.id)
    .order('updated_at', { ascending: false });

  if (!includeArchived) query = query.is('archived_at', null);

  // Status filter (allow 'all' as a wildcard via empty string)
  if (statusParam && statusParam !== 'all') {
    if (!VALID_STATUSES.has(statusParam)) {
      return json({ error: `Invalid status: ${statusParam}` }, 400);
    }
    query = query.eq('status', statusParam);
  }

  // Group filter: time-based windows
  if (group === 'due-this-week') {
    const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.lte('response_due', inAWeek).not('response_due', 'is', null);
  } else if (group === 'due-this-month') {
    const inAMonth = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    query = query.lte('response_due', inAMonth).not('response_due', 'is', null);
  }

  // Search filter — client + counter_party substring match
  if (q) {
    const safe = q.replace(/[%_]/g, '\\$&');
    query = query.or(`client.ilike.%${safe}%,counter_party.ilike.%${safe}%`);
  }

  const { data: matters, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const ids = (matters || []).map((m) => m.id);
  const counts = {};
  if (ids.length) {
    const [{ data: items }, { data: pending }, { data: audit }] = await Promise.all([
      supabase.from('paralegal_matter_items').select('matter_id').in('matter_id', ids),
      supabase.from('paralegal_pending_actions').select('matter_id').in('matter_id', ids).eq('status', 'pending'),
      supabase.from('paralegal_audit_log').select('matter_id').in('matter_id', ids),
    ]);
    for (const id of ids) counts[id] = { items: 0, pending: 0, audit_events: 0 };
    for (const r of items || []) if (counts[r.matter_id]) counts[r.matter_id].items++;
    for (const r of pending || []) if (counts[r.matter_id]) counts[r.matter_id].pending++;
    for (const r of audit || []) if (counts[r.matter_id]) counts[r.matter_id].audit_events++;
  }

  const enriched = (matters || []).map((m) => ({
    ...m,
    counts: counts[m.id] || { items: 0, pending: 0, audit_events: 0 },
  }));

  return json({ matters: enriched });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
