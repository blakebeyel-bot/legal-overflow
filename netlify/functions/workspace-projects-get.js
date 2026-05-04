/**
 * GET /api/workspace-projects-get?id=<uuid>
 * Returns: { project, chats, documents, reviews, folders }
 *
 * Single fat-fetch for a project view — gets the project metadata
 * plus everything scoped to it.
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
  const { data: project, error } = await supabase
    .from('workspace_projects')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!project) return json({ error: 'Project not found' }, 404);

  const [chats, docs, reviews, folders] = await Promise.all([
    supabase.from('workspace_chats')
      .select('id, title, model, created_at, updated_at')
      .eq('user_id', auth.user.id).eq('project_id', id)
      .order('updated_at', { ascending: false }),
    supabase.from('workspace_documents')
      .select('id, filename, file_type, size_bytes, folder_id, created_at, updated_at, current_version_id, current_version:current_version_id(id, version_number, extraction_status, extracted_chars)')
      .eq('user_id', auth.user.id).eq('project_id', id).is('deleted_at', null)
      .order('updated_at', { ascending: false }),
    supabase.from('workspace_tabular_reviews')
      .select('id, title, status, columns_config, model, created_at, updated_at')
      .eq('user_id', auth.user.id).eq('project_id', id)
      .order('updated_at', { ascending: false }),
    supabase.from('workspace_project_folders')
      .select('id, name, created_at')
      .eq('user_id', auth.user.id).eq('project_id', id)
      .order('name', { ascending: true }),
  ]);

  return json({
    project,
    chats: chats.data || [],
    documents: docs.data || [],
    reviews: reviews.data || [],
    folders: folders.data || [],
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
