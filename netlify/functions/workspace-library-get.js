/**
 * GET /api/workspace-library-get?id=<uuid>&include_text=1
 * Returns: { document, versions: [...], current_version_text? }
 *
 * include_text=1 returns the extracted text of the current version.
 * Without it the response stays small (used by the chat picker).
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const includeText = url.searchParams.get('include_text') === '1';
  if (!id) return json({ error: 'Missing id' }, 400);

  const supabase = getSupabaseAdmin();

  const { data: doc, error: docErr } = await supabase
    .from('workspace_documents')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (docErr) return json({ error: docErr.message }, 500);
  if (!doc) return json({ error: 'Document not found' }, 404);

  const { data: versions, error: vErr } = await supabase
    .from('workspace_document_versions')
    .select('id, version_number, source, display_name, size_bytes, extraction_status, extracted_chars, extraction_detail, created_at')
    .eq('document_id', id)
    .order('version_number', { ascending: false });
  if (vErr) return json({ error: vErr.message }, 500);

  let currentText = null;
  if (includeText && doc.current_version_id) {
    const { data: cv } = await supabase
      .from('workspace_document_versions')
      .select('extracted_text')
      .eq('id', doc.current_version_id)
      .single();
    currentText = cv?.extracted_text || null;
  }

  return json({ document: doc, versions: versions || [], current_version_text: currentText });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
