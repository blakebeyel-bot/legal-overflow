/**
 * POST /api/workspace-tr-create
 *   body: {
 *     title: string,
 *     columns: [{ name, prompt }],
 *     document_ids: [uuid],
 *     model?: string,
 *     project_id?: uuid,
 *   }
 *
 * Creates a workspace_tabular_reviews row plus one
 * workspace_tabular_cells row per (document × column) pair, each
 * pending. Then fires the background fanout to actually run the
 * cells. Returns immediately with the review id so the client can
 * navigate to the grid view and stream cell results in.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const MAX_DOCS = 50;
const MAX_COLS = 25;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 200);
  const columns = Array.isArray(body.columns) ? body.columns.slice(0, MAX_COLS) : [];
  const docIds = Array.isArray(body.document_ids) ? body.document_ids.slice(0, MAX_DOCS) : [];
  const model = String(body.model || 'claude-sonnet-4-5').slice(0, 100);
  const projectId = body.project_id || null;

  if (!title) return json({ error: 'Missing title' }, 400);
  if (!columns.length) return json({ error: 'At least one column required' }, 400);
  if (!docIds.length) return json({ error: 'At least one document required' }, 400);

  // Normalize columns: each must have a name and a prompt.
  const normCols = columns.map((c, i) => ({
    index: i,
    name: String(c.name || `Column ${i + 1}`).slice(0, 100),
    prompt: String(c.prompt || '').slice(0, 2000),
  }));
  if (normCols.some((c) => !c.prompt.trim())) {
    return json({ error: 'Every column needs a prompt' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // Verify all document ids belong to this user (defense in depth — RLS
  // would also block this, but the service-role client bypasses RLS).
  const { data: ownedDocs, error: docErr } = await supabase
    .from('workspace_documents')
    .select('id, current_version_id')
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .in('id', docIds);
  if (docErr) return json({ error: docErr.message }, 500);
  if ((ownedDocs || []).length !== docIds.length) {
    return json({ error: 'One or more documents not found or not yours' }, 400);
  }

  // Insert the review row
  const { data: review, error: revErr } = await supabase
    .from('workspace_tabular_reviews')
    .insert({
      user_id: auth.user.id,
      project_id: projectId,
      title,
      columns_config: normCols,
      model,
      status: 'pending',
    })
    .select('*')
    .single();
  if (revErr) return json({ error: revErr.message }, 500);

  // Insert N×M pending cells
  const cellRows = [];
  for (const docId of docIds) {
    for (const col of normCols) {
      cellRows.push({
        review_id: review.id,
        document_id: docId,
        column_index: col.index,
        status: 'pending',
        model_used: model,
      });
    }
  }
  // Chunk to avoid hitting any row limits
  for (let i = 0; i < cellRows.length; i += 500) {
    const chunk = cellRows.slice(i, i + 500);
    const { error: cErr } = await supabase.from('workspace_tabular_cells').insert(chunk);
    if (cErr) {
      await supabase.from('workspace_tabular_reviews').delete().eq('id', review.id);
      return json({ error: `Cell insert failed: ${cErr.message}` }, 500);
    }
  }

  // Fire the background fanout. We don't await — it runs up to 15 min
  // independently. Errors will be persisted on the cell rows.
  fireFanout(review.id, auth.user.id);

  return json({
    review_id: review.id,
    cells_pending: cellRows.length,
    total_calls: cellRows.length,
  });
};

function fireFanout(reviewId, userId) {
  // Build the absolute URL. Netlify auto-routes /.netlify/functions/<name>
  // back to itself; we just need a working host. URL env vars point at
  // the deployed site; in local dev URL is http://localhost:8888.
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  const fanoutUrl = `${base}/.netlify/functions/workspace-tr-run-background`;
  fetch(fanoutUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'tr-create' },
    body: JSON.stringify({ review_id: reviewId, user_id: userId }),
  }).catch((err) => console.error('fireFanout failed:', err.message));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
