/**
 * GET /api/workspace-workflows-get?id=<uuid>
 * Returns: { workflow }
 *
 * Visible if user owns it OR it's system+published.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_workflows')
    .select('*')
    .eq('id', id)
    .or(`user_id.eq.${auth.user.id},and(user_id.is.null,is_published.eq.true)`)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'Workflow not found' }, 404);
  return json({ workflow: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
