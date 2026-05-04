/**
 * GET /api/admin-list-users
 *
 * Returns every signed-up user with their approval state and per-user
 * quota overrides. Admin only.
 *
 * Response:
 *   { users: [{ id, email, tier, approved_at, approval_note,
 *               review_cap_override, citation_cap_override,
 *               reviews_used, citations_used, created_at }, ...] }
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const supabase = getSupabaseAdmin();

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, tier, approved_at, approval_note, review_cap_override, citation_cap_override, created_at')
    .order('created_at', { ascending: false });
  if (error) return json({ error: error.message }, 500);

  // Pull review counts per user from reviews_current_window
  const { data: windowRows } = await supabase
    .from('reviews_current_window')
    .select('user_id, reviews_total');
  const reviewsByUser = new Map((windowRows || []).map(r => [r.user_id, r.reviews_total]));

  // Citation counts — direct from verification_runs in last 30 days
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: cites } = await supabase
    .from('verification_runs')
    .select('user_id')
    .gte('created_at', since);
  const citesByUser = new Map();
  for (const c of (cites || [])) {
    citesByUser.set(c.user_id, (citesByUser.get(c.user_id) || 0) + 1);
  }

  const users = (profiles || []).map((p) => ({
    id: p.id,
    email: p.email,
    tier: p.tier,
    approved_at: p.approved_at,
    approval_note: p.approval_note,
    review_cap_override: p.review_cap_override,
    citation_cap_override: p.citation_cap_override,
    reviews_used: reviewsByUser.get(p.id) || 0,
    citations_used: citesByUser.get(p.id) || 0,
    created_at: p.created_at,
  }));

  return json({ users });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
