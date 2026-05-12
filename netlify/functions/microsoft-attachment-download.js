/**
 * POST /api/microsoft-attachment-download
 *   body: {
 *     message_id: string,                  // Graph message id
 *     attachment_id: string,               // Graph attachment id
 *     matter_id?: uuid,                    // optionally auto-attach to a matter
 *     attach_kind?: 'library_document'     // default 'library_document'
 *   }
 *
 * Downloads the attachment bytes from Microsoft Graph, uploads them to
 * the Supabase Storage 'library' bucket, registers in workspace_documents
 * + workspace_document_versions (re-using the same shape
 * workspace-library-register uses), and optionally links the result to
 * a matter via paralegal_matter_items.
 *
 * Returns: { document_id, version_id, attached_matter_item_id? }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { getAttachment } from '../lib/microsoft-graph.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { message_id, attachment_id, matter_id } = body || {};
  if (!message_id || !attachment_id) return json({ error: 'message_id and attachment_id required' }, 400);

  let blob;
  try {
    blob = await getAttachment(auth.user.id, message_id, attachment_id);
  } catch (err) {
    if (/not connected/i.test(err.message || '')) return json({ error: err.message, not_connected: true }, 412);
    return json({ error: err.message || 'Attachment fetch failed' }, 502);
  }

  const supabase = getSupabaseAdmin();

  // Pre-create the document row so we can derive the storage path before upload.
  const { data: doc, error: docErr } = await supabase
    .from('workspace_documents')
    .insert({
      user_id: auth.user.id,
      filename: blob.name,
      original_filename: blob.name,
      file_type: blob.contentType || 'application/octet-stream',
      size_bytes: blob.size || blob.bytes.length,
      status: 'processing',
      library_hidden: false,
    })
    .select('*')
    .single();
  if (docErr) return json({ error: docErr.message }, 500);

  // Same path convention as workspace-library-register expects
  const ext = (blob.name.split('.').pop() || 'bin').toLowerCase().slice(0, 8);
  const versionId = crypto.randomUUID();
  const storagePath = `${auth.user.id}/${doc.id}/${versionId}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('library')
    .upload(storagePath, blob.bytes, {
      contentType: blob.contentType || 'application/octet-stream',
      upsert: false,
    });
  if (uploadErr) {
    await supabase.from('workspace_documents').delete().eq('id', doc.id);
    return json({ error: `Storage upload failed: ${uploadErr.message}` }, 500);
  }

  const { data: version, error: vErr } = await supabase
    .from('workspace_document_versions')
    .insert({
      id: versionId,
      document_id: doc.id,
      version_number: 1,
      storage_path: storagePath,
      source: 'graph_attachment',
      display_name: `v1 — Outlook attachment`,
      size_bytes: blob.size || blob.bytes.length,
      extraction_status: 'pending',
    })
    .select('*')
    .single();
  if (vErr) {
    await supabase.storage.from('library').remove([storagePath]).catch(() => {});
    await supabase.from('workspace_documents').delete().eq('id', doc.id);
    return json({ error: vErr.message }, 500);
  }

  // Optional: attach to matter
  let attachedMatterItem = null;
  if (matter_id) {
    const { data: mi, error: miErr } = await supabase
      .from('paralegal_matter_items')
      .insert({
        matter_id,
        user_id: auth.user.id,
        item_kind: 'library_document',
        item_ref_id: doc.id,
        metadata: {
          title: blob.name,
          source: 'outlook_attachment',
          graph_message_id: message_id,
          graph_attachment_id: attachment_id,
        },
        attached_by: 'user',
      })
      .select('*')
      .single();
    if (!miErr) attachedMatterItem = mi;
    else console.warn('[microsoft-attachment-download] matter-attach failed:', miErr.message);
  }

  // Fire the background text-extract pipeline (best-effort; safe to skip)
  const triggerUrl = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/workspace-doc-extract-background`;
  fetch(triggerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'doc-extract' },
    body: JSON.stringify({
      document_id: doc.id,
      version_id: version.id,
      storage_path: storagePath,
      user_id: auth.user.id,
    }),
  }).catch((err) => console.warn('[microsoft-attachment-download] extract trigger failed:', err.message));

  return json({
    document_id: doc.id,
    version_id: version.id,
    filename: blob.name,
    size_bytes: blob.size || blob.bytes.length,
    attached_matter_item_id: attachedMatterItem?.id || null,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
