/**
 * POST /api/workspace-projects-create
 *   body: { name, description? }
 * Returns: { project }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 200);
  const description = String(body.description || '').slice(0, 2000);
  if (!name) return json({ error: 'Name required' }, 400);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_projects')
    .insert({ user_id: auth.user.id, name, description })
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ project: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
