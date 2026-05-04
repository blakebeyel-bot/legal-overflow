/**
 * GET /api/admin-workflows-list  (admin tier required)
 * Returns ALL system workflows (published + unpublished). Different
 * from workspace-workflows-list which only shows published ones to
 * non-admin users.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_workflows')
    .select('*')
    .is('user_id', null)
    .order('updated_at', { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ workflows: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
