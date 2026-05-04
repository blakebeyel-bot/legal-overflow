/**
 * POST /api/workspace-folders-delete
 *   body: { id }
 * Documents in the folder fall out (folder_id set to NULL) — not deleted.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'POST/DELETE only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  if (!body.id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_project_folders')
    .delete()
    .eq('id', body.id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
