/**
 * GET /api/workspace-library-list
 *   ?project_id=<uuid>     filter to a project (or "null" for global library)
 *   ?folder_id=<uuid>      filter to a folder
 *   ?q=<text>              search filename
 *   ?limit=200             default 200
 *
 * Returns: { documents: [...] } excluding soft-deleted rows. Each
 * document includes the current version metadata (extraction status,
 * version number) but NOT the full extracted text — that's a separate
 * call via workspace-library-get.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');
  const folderId = url.searchParams.get('folder_id');
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('workspace_documents')
    .select(`
      id, user_id, project_id, folder_id, filename, original_filename,
      file_type, size_bytes, status, status_detail,
      current_version_id, created_at, updated_at,
      current_version:current_version_id (
        id, version_number, extraction_status, extracted_chars
      )
    `)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (projectId === 'null' || projectId === '') query = query.is('project_id', null);
  else if (projectId) query = query.eq('project_id', projectId);
  if (folderId === 'null' || folderId === '') query = query.is('folder_id', null);
  else if (folderId) query = query.eq('folder_id', folderId);
  if (q) query = query.ilike('filename', `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`);

  const { data, error } = await query;
  if (error) return json({ error: error.message }, 500);
  return json({ documents: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
