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

  // Insert document row. library_hidden is set when the user uploaded
  // via the Vault page and chose "Vault only" — the file goes through
  // the normal extraction pipeline but doesn't show in the Library UI.
  const libraryHidden = body.library_hidden === true;
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
      library_hidden: libraryHidden,
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
      extraction_method: extraction.method || null,
      extracted_format: extraction.format || 'plain',
    })
    .eq('id', version.id);

  await supabase
    .from('workspace_documents')
    .update({
      status: 'ready',
      status_detail: extraction.status === 'failed' ? extraction.detail : null,
    })
    .eq('id', doc.id);

  // ---- Async OCR fallback ----
  // Image files and sparse-text PDFs (DocuSign / scanned) come back
  // with status='pending_ocr'. Fire the background OCR job; it will
  // populate extracted_text and flip status to 'done' (or 'failed').
  // skipVaultIngest is forwarded so the OCR job knows whether to also
  // auto-ingest after extraction completes.
  if (extraction.status === 'pending_ocr') {
    fireOcr({ documentId: doc.id, versionId: version.id, userId: auth.user.id, skipVaultIngest: body.skip_vault_ingest === true });
  }

  // ---- Auto-ingest into Vault (sync extraction path only) ----
  // OCR path defers vault ingestion to the background OCR job (which
  // runs vault.addVaultItem itself once OCR completes). The sync path
  // (PDF text, DOCX, plaintext) auto-ingests here.
  //
  // Caller can override the user-level auto-ingest setting per-upload
  // via skip_vault_ingest=true (e.g. when the user explicitly chose
  // "Library only" in the Vault page's upload modal).
  const skipVaultIngest = body.skip_vault_ingest === true;
  if (!skipVaultIngest && extraction.status === 'done' && storedText && storedText.trim()) {
    // Detect format for the optional image pipeline (Phase 2+ of
    // the multimodal RAG rollout). When the user's image-extraction
    // setting is on AND the env flag permits, addVaultItem will
    // walk the original buffer for embedded images, stage them,
    // generate captions, and inline them into the chunk text.
    let ingestFormat = null;
    const ftLower = String(file_type || '').toLowerCase();
    const fnLower = String(original_filename || '').toLowerCase();
    if (ftLower.includes('wordprocessingml') || fnLower.endsWith('.docx')) ingestFormat = 'docx';
    else if (ftLower.includes('pdf') || fnLower.endsWith('.pdf')) ingestFormat = 'pdf';
    fireVaultAutoIngest({
      userId: auth.user.id,
      docId: doc.id,
      title: original_filename || filename || 'Untitled document',
      content: storedText,
      // We already downloaded the buffer above for extraction;
      // re-download isn't necessary if we capture it. The
      // re-download-aware approach below keeps the change minimal:
      // pass the storage_path so fireVaultAutoIngest can fetch
      // bytes only when image extraction is actually enabled
      // (avoiding wasted bandwidth in the common case where the
      // flag is off).
      storagePath: storage_path,
      format: ingestFormat,
    });
  }

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
      method: extraction.method,
      format: extraction.format,
    },
  });
};

/**
 * Fire-and-forget kick to the OCR background function. Used when
 * the synchronous extractor returned status='pending_ocr' (image
 * files, scanned/DocuSign PDFs).
 */
function fireOcr({ documentId, versionId, userId, skipVaultIngest = false }) {
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  const url = `${base}/.netlify/functions/workspace-doc-extract-background`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'library-register' },
    body: JSON.stringify({
      document_id: documentId,
      version_id: versionId,
      user_id: userId,
      skip_vault_ingest: !!skipVaultIngest,
    }),
  }).catch((err) => console.error('fireOcr failed:', err.message));
}

/**
 * Fire-and-forget vault auto-ingest. Loads the user's settings
 * server-side and only ingests if vault_auto_ingest_uploads is on.
 * This is server-side (not a separate HTTP call) because the
 * register endpoint is itself authenticated; we can call vault.js
 * directly using the admin client.
 */
async function fireVaultAutoIngest({ userId, docId, title, content, storagePath, format }) {
  try {
    const { getSupabaseAdmin } = await import('../lib/supabase-admin.js');
    const supabase = getSupabaseAdmin();
    const { data: settings } = await supabase
      .from('workspace_user_settings')
      .select('vault_auto_ingest_uploads, vault_image_extraction_enabled')
      .eq('user_id', userId)
      .maybeSingle();
    const enabled = settings ? !!settings.vault_auto_ingest_uploads : true;
    if (!enabled) return;

    // Decide whether to fetch the original bytes for the image
    // pipeline. Only do this when:
    //   - User opted into image extraction
    //   - Env var permits
    //   - We have a storagePath + recognized format
    // In every other case we skip the storage download — saves
    // bandwidth + latency on the common text-only path.
    const { imageExtractionEnvEnabled } = await import('../lib/vault-images.js');
    let originalBytes = null;
    const userOptIn = !!settings?.vault_image_extraction_enabled;
    if (userOptIn && imageExtractionEnvEnabled() && storagePath && (format === 'docx' || format === 'pdf')) {
      try {
        const { data: file, error: dlErr } = await supabase.storage
          .from('library')
          .download(storagePath);
        if (dlErr) throw new Error(dlErr.message);
        const ab = await file.arrayBuffer();
        originalBytes = Buffer.from(ab);
      } catch (err) {
        console.warn('[vault auto-ingest] image-pipeline storage fetch failed:', err.message);
        // Fall through with originalBytes = null — addVaultItem
        // will simply skip image work and ingest text-only.
      }
    }

    const { addVaultItem } = await import('../lib/vault.js');
    await addVaultItem({
      supabase,
      userId,
      sourceKind: 'document',
      sourceIds: { docId },
      title,
      content,
      originalBytes,
      format: originalBytes ? format : null,
    });
  } catch (err) {
    console.error('vault auto-ingest failed:', err.message);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
