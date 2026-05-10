/**
 * POST /api/workspace-doc-extract-background
 *   body: { document_id, version_id, user_id }
 *
 * Background function (Netlify gives -background suffixed functions
 * up to 15 min runtime). Used when sync extraction returned
 * status='pending_ocr' — i.e. an image upload or a scanned/DocuSign
 * PDF whose pdfjs text-extraction came back sparse.
 *
 * Pipeline:
 *   1. Download the original file from the `library` Storage bucket
 *   2. Run OCR (Gemini Flash vision) — page-by-page for PDFs, single
 *      shot for image files
 *   3. Persist the resulting markdown back to
 *      workspace_document_versions.extracted_text and flip
 *      extraction_status='done'
 *   4. If the user has vault auto-ingest on, chain into addVaultItem
 *      so the freshly-OCR'd doc lands in their vault automatically
 *
 * Errors are persisted to extraction_status='failed' with detail; the
 * library UI surfaces them on the doc card.
 */

import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { ocrPdf, ocrImage, isImageFile, resolveOcrKey } from '../lib/ocr.js';
import { addVaultItem } from '../lib/vault.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => ({}));
  const documentId = body.document_id;
  const versionId  = body.version_id;
  const userId     = body.user_id;
  if (!documentId || !versionId || !userId) {
    return new Response('missing document_id / version_id / user_id', { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  // 1. Verify ownership + load metadata
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, user_id, filename, original_filename, file_type')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!doc) return new Response('document not found', { status: 404 });

  const { data: version } = await supabase
    .from('workspace_document_versions')
    .select('id, document_id, storage_path, extraction_status')
    .eq('id', versionId)
    .eq('document_id', documentId)
    .maybeSingle();
  if (!version) return new Response('version not found', { status: 404 });

  // Mark running
  await supabase
    .from('workspace_document_versions')
    .update({ extraction_status: 'running', extraction_detail: 'OCR in progress' })
    .eq('id', versionId);

  try {
    // 2. Download the file from Storage
    const { data: blob, error: dlErr } = await supabase.storage
      .from('library')
      .download(version.storage_path);
    if (dlErr || !blob) throw new Error(`Storage download failed: ${dlErr?.message || 'no blob'}`);
    const ab = await blob.arrayBuffer();
    const buf = Buffer.from(ab);

    // 3. Resolve OCR key (BYOK Google → GOOGLE_AI_API_KEY)
    const { key: ocrKey } = await resolveOcrKey({ userId });

    // 4. Route by file kind
    const fileType = (doc.file_type || '').toLowerCase();
    const filename = doc.original_filename || doc.filename || '';
    const ext = filename.toLowerCase().split('.').pop();

    let markdown = '';
    let pageCount = null;

    if (isImageFile({ fileType, filename })) {
      const mime = fileType.startsWith('image/') ? fileType : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      const out = await ocrImage({ imageBytes: buf, mimeType: mime, apiKey: ocrKey });
      markdown = out.markdown;
      pageCount = 1;
    } else {
      // Assume PDF (the library register only sends here for image/PDF)
      const out = await ocrPdf({
        pdfBytes: buf,
        apiKey: ocrKey,
        onProgress: async (done, total) => {
          // ocrPdf reports per chunk (each chunk = up to 8 pages).
          // Surface a friendly running estimate.
          const pct = Math.min(99, Math.round((done / Math.max(1, total)) * 100));
          await supabase
            .from('workspace_document_versions')
            .update({ extraction_detail: `OCR running (${done}/${total} chunks · ${pct}%)` })
            .eq('id', versionId);
        },
      });
      markdown = out.markdown;
      pageCount = out.pageCount;
    }

    if (!markdown || !markdown.trim()) {
      throw new Error('OCR produced empty output');
    }

    // 5. Persist
    await supabase
      .from('workspace_document_versions')
      .update({
        extracted_text: markdown,
        extracted_chars: markdown.length,
        extraction_status: 'done',
        extraction_detail: null,
        extraction_method: 'ocr',
        extracted_format: 'markdown',
      })
      .eq('id', versionId);

    // 6. If user has auto-ingest on AND the caller didn't override
    //    via skip_vault_ingest, chain into vault.
    const skipVault = body.skip_vault_ingest === true;
    const { data: settings } = await supabase
      .from('workspace_user_settings')
      .select('vault_auto_ingest_uploads')
      .eq('user_id', userId)
      .maybeSingle();
    const autoIngest = settings ? !!settings.vault_auto_ingest_uploads : true;
    if (autoIngest && !skipVault) {
      try {
        // Pass the original file bytes through to the vault ingest
        // so the multimodal image pipeline can run when enabled.
        // Standalone image uploads (PNG/JPG/etc) → format='image';
        // OCR'd PDFs (DocuSign, scanned) → format='pdf' so the PDF
        // image extractor walks the embedded XObjects (born-digital
        // PDFs that just happened to be sparse-text). For pure-scan
        // PDFs the extractor will find no images and silently skip.
        let ingestFormat = null;
        let ingestMime = null;
        if (isImageFile({ fileType, filename })) {
          ingestFormat = 'image';
          ingestMime = fileType.startsWith('image/') ? fileType : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        } else {
          ingestFormat = 'pdf';
        }
        await addVaultItem({
          supabase,
          userId,
          sourceKind: 'document',
          sourceIds: { docId: documentId },
          title: filename || 'Untitled document',
          content: markdown,
          tags: ['ocr'],
          originalBytes: buf,
          format: ingestFormat,
          mimeType: ingestMime,
        });
      } catch (vErr) {
        // Don't fail the OCR job if vault insert fails — the doc is
        // saved either way.
        console.error('[doc-extract-background] vault auto-ingest failed:', vErr.message);
      }
    }

    console.log(`[doc-extract-background] ${documentId}/${versionId} ok (${markdown.length} chars, ${pageCount} pages)`);
    return new Response('ok');
  } catch (err) {
    console.error('[doc-extract-background] failed:', err);
    await supabase
      .from('workspace_document_versions')
      .update({
        extraction_status: 'failed',
        extraction_detail: (err && err.message ? err.message : String(err)).slice(0, 1000),
      })
      .eq('id', versionId);
    return new Response('failed: ' + (err.message || err), { status: 500 });
  }
};
