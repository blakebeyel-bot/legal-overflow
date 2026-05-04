/**
 * POST /api/workspace-library-register
 *   body: {
 *     filename: string,         // user-visible name (defaults to original_filename)
 *     original_filename: string,
 *     file_type: string,        // MIME type
 *     size_bytes: number,
 *     storage_path: string,     // path inside the 'library' bucket: <user_id>/<doc_id>/<version_id>.<ext>
 *     project_id?: uuid,
 *     folder_id?: uuid,
 *   }
 *
 * Browser uploads the file directly to Supabase Storage first (using
 * its own session token + the row-level policy in migration 0014).
 * Then it POSTs here to:
 *   1. Insert the workspace_documents + workspace_document_versions rows.
 *   2. Download the file back from storage and extract its text
 *      synchronously (PDFs/DOCX up to ~6MB take 2-15s).
 *   3. Cache the extracted text on the version row so subsequent
 *      chat messages just read from the DB.
 *
 * Returns: { document, version } — both DB rows.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { extractTextFromBuffer } from '../lib/library-extract.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const {
    filename, original_filename, file_type, size_bytes, storage_path,
    project_id, folder_id,
  } = body;
  if (!storage_path) return json({ error: 'Missing storage_path' }, 400);
  if (!original_filename) return json({ error: 'Missing original_filename' }, 400);

  // Storage path must start with the user's id so RLS / our auth lines up.
  const expectedPrefix = `${auth.user.id}/`;
  if (!storage_path.startsWith(expectedPrefix)) {
    return json({ error: 'storage_path must start with your user id' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // Insert document row
  const { data: doc, error: docErr } = await supabase
    .from('workspace_documents')
    .insert({
      user_id: auth.user.id,
      project_id: project_id || null,
      folder_id: folder_id || null,
      filename: filename || original_filename,
      original_filename,
      file_type: file_type || 'application/octet-stream',
      size_bytes: size_bytes || 0,
      status: 'processing',
    })
    .select('*')
    .single();
  if (docErr) return json({ error: docErr.message }, 500);

  // Insert v1 version row
  const { data: version, error: vErr } = await supabase
    .from('workspace_document_versions')
    .insert({
      document_id: doc.id,
      version_number: 1,
      storage_path,
      source: 'upload',
      display_name: 'v1 — original upload',
      size_bytes: size_bytes || 0,
      extraction_status: 'running',
    })
    .select('*')
    .single();
  if (vErr) {
    // Roll back document row so we don't orphan it
    await supabase.from('workspace_documents').delete().eq('id', doc.id);
    return json({ error: vErr.message }, 500);
  }

  // Set current_version_id on the document row
  await supabase
    .from('workspace_documents')
    .update({ current_version_id: version.id })
    .eq('id', doc.id);

  // Now extract text synchronously. We download the file we just
  // received the path for, run it through pdfjs/mammoth, and cache
  // the result on the version row. This keeps subsequent chat
  // messages cheap — no re-extraction per message.
  let extraction = { text: '', chars: 0, status: 'failed', detail: 'unknown' };
  try {
    const { data: file, error: dlErr } = await supabase.storage
      .from('library')
      .download(storage_path);
    if (dlErr) throw new Error(`storage download failed: ${dlErr.message}`);
    const ab = await file.arrayBuffer();
    const buf = Buffer.from(ab);
    extraction = await extractTextFromBuffer({
      buffer: buf,
      fileType: file_type,
      filename: original_filename,
    });
  } catch (err) {
    extraction = { text: '', chars: 0, status: 'failed', detail: err.message };
  }

  // Cap extracted text at 1.5M chars (~400k tokens) so we don't blow
  // up Postgres rows for absurd documents. Anything bigger gets
  // truncated; the last 200 chars get a "[...truncated]" marker.
  const TEXT_CAP = 1_500_000;
  let storedText = extraction.text;
  if (storedText && storedText.length > TEXT_CAP) {
    storedText = storedText.slice(0, TEXT_CAP - 200) + '\n\n[...truncated]';
  }

  await supabase
    .from('workspace_document_versions')
    .update({
      extraction_status: extraction.status,
      extraction_detail: extraction.detail || null,
      extracted_text: storedText || null,
      extracted_chars: extraction.chars || null,
    })
    .eq('id', version.id);

  await supabase
    .from('workspace_documents')
    .update({
      status: extraction.status === 'failed' ? 'ready' : 'ready',  // file is ready even if text extraction failed
      status_detail: extraction.status === 'failed' ? extraction.detail : null,
    })
    .eq('id', doc.id);

  // Re-fetch the canonical doc + version to return
  const [{ data: finalDoc }, { data: finalVersion }] = await Promise.all([
    supabase.from('workspace_documents').select('*').eq('id', doc.id).single(),
    supabase.from('workspace_document_versions').select('*').eq('id', version.id).single(),
  ]);

  return json({
    document: finalDoc,
    version: finalVersion,
    extraction: {
      status: extraction.status,
      chars: extraction.chars,
      detail: extraction.detail,
    },
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
