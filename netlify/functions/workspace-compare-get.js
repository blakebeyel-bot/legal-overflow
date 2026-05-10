/**
 * GET /api/workspace-compare-get?id=<run_id>
 * Returns: { run, diffs, base_document, proposed_document }
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
  const { data: run, error } = await supabase
    .from('workspace_compare_runs')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!run) return json({ error: 'Run not found' }, 404);

  const { data: diffs } = await supabase
    .from('workspace_compare_diffs')
    .select('*')
    .eq('run_id', id)
    .order('diff_index', { ascending: true });

  const { data: docs } = await supabase
    .from('workspace_documents')
    .select('id, filename, file_type, original_filename, current_version_id')
    .in('id', [run.base_document_id, run.proposed_document_id]);
  const base_document = docs?.find((d) => d.id === run.base_document_id) || null;
  const proposed_document = docs?.find((d) => d.id === run.proposed_document_id) || null;

  // If the run has been finalized, sign a short-lived download URL for
  // the redlined output so the UI can hand it directly to the user
  // without needing a separate download endpoint. 5-min TTL — the
  // signed URL is regenerated on every poll so it stays fresh as long
  // as the user has the page open.
  let finalized_url = null;
  let finalized_filename = null;
  if (run.finalized_version_id) {
    const { data: finalVer } = await supabase
      .from('workspace_document_versions')
      .select('storage_path, display_name, document_id')
      .eq('id', run.finalized_version_id)
      .maybeSingle();
    if (finalVer?.storage_path) {
      const { data: signed, error: signErr } = await supabase.storage
        .from('library')
        .createSignedUrl(finalVer.storage_path, 5 * 60);
      if (!signErr && signed?.signedUrl) {
        finalized_url = signed.signedUrl;
        const proposedFilename = proposed_document?.filename || 'document';
        const base = proposedFilename.replace(/\.(docx|pdf)$/i, '');
        const ext = run.finalized_format || 'docx';
        finalized_filename = `${base} — redline.${ext}`;
      }
    }
  }

  return json({
    run,
    diffs: diffs || [],
    base_document,
    proposed_document,
    finalized_url,
    finalized_filename,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
