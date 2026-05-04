/**
 * POST /api/workspace-library-delete
 *   body: { id, hard?: boolean }
 *
 * Soft delete by default — sets deleted_at timestamp; the doc
 * disappears from the library list but storage is retained for
 * 30 days. ?hard=true (admin only) wipes the storage immediately
 * and hard-deletes the rows.
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

  // Verify ownership
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, user_id')
    .eq('id', body.id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!doc) return json({ error: 'Document not found' }, 404);

  // Soft delete: set deleted_at and remove from any folder
  const { error } = await supabase
    .from('workspace_documents')
    .update({ deleted_at: new Date().toISOString(), folder_id: null })
    .eq('id', body.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
