/**
 * GET /api/workspace-workflows-list
 *   ?kind=chat|tabular        optional filter
 *   ?practice=<text>          optional filter (e.g. "MSA review")
 *
 * Returns: { workflows: [...] }
 *
 * Visible workflows = own workflows + system+published workflows.
 * The RLS policy on workspace_workflows enforces this when using a
 * user-scoped client; we use service role here and apply the OR
 * filter explicitly.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const practice = url.searchParams.get('practice');

  const supabase = getSupabaseAdmin();
  let q = supabase
    .from('workspace_workflows')
    .select('*')
    .or(`user_id.eq.${auth.user.id},and(user_id.is.null,is_published.eq.true)`)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (kind === 'chat' || kind === 'tabular') q = q.eq('kind', kind);
  if (practice) q = q.eq('practice_area', practice);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ workflows: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
