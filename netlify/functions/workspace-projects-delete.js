/**
 * POST /api/workspace-projects-delete
 *   body: { id, cascade?: boolean }
 *
 * Default: removes project_id from contained items so they fall back
 * to the global workspace, then deletes the project row.
 * cascade=true: hard-deletes chats and reviews; soft-deletes documents
 * (so the user doesn't lose source files accidentally).
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
  const cascade = !!body.cascade;
  const supabase = getSupabaseAdmin();

  // Verify ownership
  const { data: proj } = await supabase
    .from('workspace_projects')
    .select('id')
    .eq('id', body.id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!proj) return json({ error: 'Project not found' }, 404);

  if (cascade) {
    await supabase.from('workspace_chats').delete().eq('project_id', body.id).eq('user_id', auth.user.id);
    await supabase.from('workspace_tabular_reviews').delete().eq('project_id', body.id).eq('user_id', auth.user.id);
    await supabase.from('workspace_documents').update({ deleted_at: new Date().toISOString() }).eq('project_id', body.id).eq('user_id', auth.user.id);
  } else {
    // Move contained items back to global workspace
    await supabase.from('workspace_chats').update({ project_id: null }).eq('project_id', body.id).eq('user_id', auth.user.id);
    await supabase.from('workspace_tabular_reviews').update({ project_id: null }).eq('project_id', body.id).eq('user_id', auth.user.id);
    await supabase.from('workspace_documents').update({ project_id: null, folder_id: null }).eq('project_id', body.id).eq('user_id', auth.user.id);
  }

  const { error } = await supabase
    .from('workspace_projects')
    .delete()
    .eq('id', body.id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
