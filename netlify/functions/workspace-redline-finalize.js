/**
 * POST /api/workspace-redline-finalize
 *   body: { run_id }
 *
 * Builds a CLEAN (no track-changes) .docx by applying ONLY the
 * accepted edits to the original document. Saves it as a new
 * version with source='user_accept' and updates the run row's
 * finalized_version_id.
 *
 * Different from workspace-redline-run-background: that produces a
 * track-changes preview from ALL proposed edits. This produces a
 * final clean version from only the accepted subset.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval, getUserDisplayName } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const runId = body.run_id;
  if (!runId) return json({ error: 'Missing run_id' }, 400);

  const supabase = getSupabaseAdmin();

  // Fetch the run + verify ownership
  const { data: run } = await supabase
    .from('workspace_redline_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!run) return json({ error: 'Run not found' }, 404);

  // Pull the accepted edits in original order
  const { data: edits } = await supabase
    .from('workspace_redline_edits')
    .select('*')
    .eq('run_id', runId)
    .eq('status', 'accepted')
    .order('edit_index', { ascending: true });
  if (!edits || edits.length === 0) {
    return json({ error: 'No accepted edits to apply. Mark at least one edit as accepted first.' }, 400);
  }

  // Need the ORIGINAL document — we apply edits to that, not to the
  // already-redlined version (which has track-change markup that
  // would confuse the find/replace).
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, filename, original_filename, current_version_id')
    .eq('id', run.document_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!doc) return json({ error: 'Document not found' }, 404);

  // Find the ORIGINAL upload version (source='upload') — the very
  // first one. The user might have run multiple redlines; we always
  // base finalization on the original to avoid stacking changes.
  const { data: originalVersion } = await supabase
    .from('workspace_document_versions')
    .select('*')
    .eq('document_id', doc.id)
    .eq('source', 'upload')
    .order('version_number', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!originalVersion) return json({ error: 'Original document version not found' }, 500);

  // Download original from storage
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

  // POST to Fly /redline with track_changes=false → clean apply
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
        edits: edits.map((e) => ({
          find: e.find_text,
          replace: e.replace_text,
          rationale: e.rationale,
        })),
        // Universal display-name override (migration 0031, /account/)
        author: await getUserDisplayName(auth.user.id),
        track_changes: false,
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

  // Upload + register a new version
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
      source: 'user_accept',
      display_name: `v${nextVersion} — finalized (${edits.length} edits accepted)`,
      size_bytes: modifiedBytes.length,
      extraction_status: 'skipped',
    })
    .select('*')
    .single();
  if (vErr) return json({ error: `Version row insert failed: ${vErr.message}` }, 500);

  // Update the run row with the finalized reference
  await supabase
    .from('workspace_redline_runs')
    .update({
      finalized_version_id: newVersion.id,
      finalized_at: new Date().toISOString(),
    })
    .eq('id', runId);

  return json({
    ok: true,
    version: newVersion,
    edits_applied: edits.length,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
