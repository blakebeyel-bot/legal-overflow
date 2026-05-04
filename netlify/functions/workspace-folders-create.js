/**
 * POST /api/workspace-folders-create
 *   body: { project_id, name }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  if (!body.project_id) return json({ error: 'Missing project_id' }, 400);
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) return json({ error: 'Folder name required' }, 400);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_project_folders')
    .insert({ user_id: auth.user.id, project_id: body.project_id, name })
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ folder: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
