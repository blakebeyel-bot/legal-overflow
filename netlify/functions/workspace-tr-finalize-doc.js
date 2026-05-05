/**
 * POST /api/workspace-tr-finalize-doc
 *   body: { review_id, document_id }
 *
 * For a redline-mode tabular review: collects all cells where
 * redline_status='accepted' for this (review, document) pair, sends
 * them to the Fly LibreOffice service with track_changes=false, and
 * saves the resulting clean .docx as a new document version with
 * source='user_accept'. Records the result in the
 * workspace_tabular_doc_finalizations junction table.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const reviewId = body.review_id;
  const documentId = body.document_id;
  if (!reviewId || !documentId) return json({ error: 'Missing review_id or document_id' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership
  const { data: review } = await supabase
    .from('workspace_tabular_reviews')
    .select('*')
    .eq('id', reviewId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!review) return json({ error: 'Review not found' }, 404);
  if (review.kind !== 'redline') return json({ error: 'Only redline reviews can be finalized' }, 400);

  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, filename, original_filename')
    .eq('id', documentId)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!doc) return json({ error: 'Document not found' }, 404);

  // Pull accepted edits for this doc in column order
  const { data: acceptedCells } = await supabase
    .from('workspace_tabular_cells')
    .select('id, column_index, redline_find, redline_replace, redline_rationale')
    .eq('review_id', reviewId)
    .eq('document_id', documentId)
    .eq('redline_status', 'accepted')
    .not('redline_find', 'is', null)
    .order('column_index', { ascending: true });

  if (!acceptedCells || acceptedCells.length === 0) {
    return json({ error: 'No accepted edits for this document' }, 400);
  }

  // Get the original .docx (source='upload', earliest version)
  const { data: originalVersion } = await supabase
    .from('workspace_document_versions')
    .select('*')
    .eq('document_id', documentId)
    .eq('source', 'upload')
    .order('version_number', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!originalVersion) return json({ error: 'Original document version missing' }, 500);

  let originalBytes;
  try {
    const { data: file, error: dlErr } = await supabase.storage
      .from('library')
      .download(originalVersion.storage_path);
    if (dlErr) throw dlErr;
    const ab = await file.arrayBuffer();
    originalBytes = Buffer.from(ab);
  } catch (err) {
    return json({ error: `Storage download failed: ${err.message}` }, 500);
  }

  // Send to Fly with track_changes=false → clean output
  const flyUrl = process.env.LIBREOFFICE_SERVICE_URL;
  const flyToken = process.env.LIBREOFFICE_SERVICE_TOKEN;
  if (!flyUrl || !flyToken) return json({ error: 'LIBREOFFICE_SERVICE_URL / TOKEN not set' }, 500);

  let modifiedBytes;
  try {
    const flyRes = await fetch(`${flyUrl.replace(/\/$/, '')}/redline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flyToken}` },
      body: JSON.stringify({
        docx_b64: originalBytes.toString('base64'),
        edits: acceptedCells.map((c) => ({
          find: c.redline_find,
          replace: c.redline_replace || '',
          rationale: c.redline_rationale,
        })),
        author: 'Legal Overflow',
        // Produce a TRACKED-CHANGES output (not a clean doc). The user
        // is going to send this to opposing counsel, who needs to see
        // the redlines and accept/reject themselves in Word. Only the
        // user-accepted edits appear as tracked changes; rejected
        // edits never make it into the file at all.
        track_changes: true,
      }),
    });
    if (!flyRes.ok) {
      const errText = await flyRes.text().catch(() => '');
      return json({ error: `Redline service ${flyRes.status}: ${errText.slice(0, 500)}` }, 500);
    }
    const flyJson = await flyRes.json();
    modifiedBytes = Buffer.from(flyJson.docx_b64, 'base64');
  } catch (err) {
    return json({ error: `Redline service error: ${err.message}` }, 500);
  }

  // Upload + register new version
  const newVersionId = crypto.randomUUID();
  const newPath = `${auth.user.id}/${doc.id}/${newVersionId}.docx`;
  const { error: upErr } = await supabase.storage
    .from('library')
    .upload(newPath, modifiedBytes, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: false,
    });
  if (upErr) return json({ error: `Storage upload failed: ${upErr.message}` }, 500);

  const { data: maxV } = await supabase
    .from('workspace_document_versions')
    .select('version_number')
    .eq('document_id', doc.id)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxV?.version_number || 0) + 1;

  const { data: newVersion, error: vErr } = await supabase
    .from('workspace_document_versions')
    .insert({
      id: newVersionId,
      document_id: doc.id,
      version_number: nextVersion,
      storage_path: newPath,
      source: 'redline',
      display_name: `v${nextVersion} — tracked changes from review (${acceptedCells.length} edits)`,
      size_bytes: modifiedBytes.length,
      extraction_status: 'skipped',
    })
    .select('*')
    .single();
  if (vErr) return json({ error: `Version row insert failed: ${vErr.message}` }, 500);

  // Upsert the per-doc finalization record
  await supabase
    .from('workspace_tabular_doc_finalizations')
    .upsert({
      review_id: reviewId,
      document_id: documentId,
      version_id: newVersion.id,
      edits_applied: acceptedCells.length,
      finalized_at: new Date().toISOString(),
    }, { onConflict: 'review_id,document_id' });

  return json({ ok: true, version: newVersion, edits_applied: acceptedCells.length });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
