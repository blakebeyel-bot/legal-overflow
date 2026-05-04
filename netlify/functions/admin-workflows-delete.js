/**
 * POST /api/admin-workflows-delete  (admin tier required)
 *   body: { id }
 * Hard-delete a system workflow. Admin only.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'POST/DELETE only' }, 405);
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const body = await req.json().catch(() => ({}));
  if (!body.id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_workflows')
    .delete()
    .eq('id', body.id)
    .is('user_id', null);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
