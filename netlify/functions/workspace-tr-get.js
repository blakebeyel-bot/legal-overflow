/**
 * GET /api/workspace-tr-get?id=<uuid>
 * Returns: { review, cells: [...], documents: [...] }
 *
 * Cells contain content + citations (the answer + verbatim quote).
 * Documents include just enough metadata to label rows in the grid.
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
  const { data: review, error: revErr } = await supabase
    .from('workspace_tabular_reviews')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (revErr) return json({ error: revErr.message }, 500);
  if (!review) return json({ error: 'Review not found' }, 404);

  const { data: cells, error: cErr } = await supabase
    .from('workspace_tabular_cells')
    .select('id, document_id, column_index, content, citations, status, status_detail, updated_at, redline_find, redline_replace, redline_rationale, redline_status')
    .eq('review_id', id);
  if (cErr) return json({ error: cErr.message }, 500);

  const docIds = Array.from(new Set((cells || []).map((c) => c.document_id)));
  const { data: docs } = docIds.length
    ? await supabase
        .from('workspace_documents')
        .select('id, filename, file_type')
        .in('id', docIds)
    : { data: [] };

  // For redline reviews, also pull the per-doc finalization records so
  // the UI can show "v3 finalized" badges + download links.
  let finalizations = [];
  if (review.kind === 'redline' && docIds.length) {
    const { data } = await supabase
      .from('workspace_tabular_doc_finalizations')
      .select('document_id, version_id, edits_applied, finalized_at, version:version_id (id, version_number, storage_path, display_name)')
      .eq('review_id', id);
    finalizations = data || [];
  }

  // Pull per-document overviews (summary + red flags). Generated
  // alongside the cell fanout in workspace-tr-run-background. Both
  // extraction and redline reviews get them.
  const { data: overviews } = docIds.length
    ? await supabase
        .from('workspace_tabular_doc_overviews')
        .select('document_id, summary, risks, status, status_detail')
        .eq('review_id', id)
    : { data: [] };

  return json({ review, cells: cells || [], documents: docs || [], finalizations, overviews: overviews || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
