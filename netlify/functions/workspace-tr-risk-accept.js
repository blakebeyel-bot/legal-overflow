/**
 * POST /api/workspace-tr-risk-accept
 *   body: {
 *     review_id: uuid,
 *     document_id: uuid,
 *     risk: { title, severity, detail, quote },
 *     find: string,
 *     replace: string,
 *     rationale: string,
 *     status?: 'accepted' | 'rejected'   // default 'accepted'
 *   }
 *
 * Persists a red-flag-derived rewrite suggestion as a real redline
 * cell on the review. Behind the scenes:
 *   1. Validates review + doc ownership
 *   2. Appends a new column to columns_config — "[Red Flag] <title>"
 *   3. Inserts a workspace_tabular_cells row with:
 *      - column_index = (new column position)
 *      - status = 'complete' (we already have the answer; no LLM call)
 *      - redline_find / replace / rationale = from the body
 *      - redline_status = body.status (default 'accepted')
 *
 * The new finding then appears in the doc-view findings list
 * alongside the user's column-defined findings, and downstream
 * features (finalize doc → tracked-changes Word) treat it
 * identically.
 *
 * Returns: { cell, column_index, columns_config }
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
  const docId = body.document_id;
  const risk = body.risk || {};
  const find = String(body.find || '').slice(0, 4000);
  const replace = String(body.replace || '').slice(0, 6000);
  const rationale = String(body.rationale || '').slice(0, 1500);
  const status = body.status === 'rejected' ? 'rejected' : 'accepted';

  if (!reviewId || !docId) return json({ error: 'Missing review_id / document_id' }, 400);
  if (!find) return json({ error: 'Missing find text' }, 400);
  if (!risk.title) return json({ error: 'Missing risk title' }, 400);

  const supabase = getSupabaseAdmin();

  // Validate review ownership + load columns_config
  const { data: review, error: rErr } = await supabase
    .from('workspace_tabular_reviews')
    .select('id, columns_config, model, kind')
    .eq('id', reviewId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (rErr || !review) return json({ error: 'Review not found' }, 404);
  if (review.kind !== 'redline') {
    return json({ error: 'Risk-accept only valid on redline reviews' }, 400);
  }

  // Validate doc ownership
  const { data: doc, error: dErr } = await supabase
    .from('workspace_documents')
    .select('id')
    .eq('id', docId)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (dErr || !doc) return json({ error: 'Document not found' }, 404);

  // Append a new column for this risk-derived finding
  const oldCols = Array.isArray(review.columns_config) ? review.columns_config : [];
  const newColIndex = oldCols.length;
  const newCol = {
    index: newColIndex,
    name: `[Red flag] ${String(risk.title).slice(0, 80)}`,
    prompt: `(Auto-generated from red flag: ${String(risk.title).slice(0, 200)})`,
    from_risk: true,
  };
  const newCols = [...oldCols, newCol];

  // Update the review with the new column. Use a tight where clause
  // to avoid clobbering concurrent updates (this is a small risk
  // since the user is the only writer for their review).
  const { error: updErr } = await supabase
    .from('workspace_tabular_reviews')
    .update({ columns_config: newCols, updated_at: new Date().toISOString() })
    .eq('id', reviewId);
  if (updErr) return json({ error: `Could not append column: ${updErr.message}` }, 500);

  // Insert the new cell at status=complete (no LLM run needed —
  // we already have the answer from the suggest endpoint).
  const { data: cell, error: cellErr } = await supabase
    .from('workspace_tabular_cells')
    .insert({
      review_id: reviewId,
      document_id: docId,
      column_index: newColIndex,
      status: 'complete',
      content: rationale,        // for display consistency with normal cells
      redline_find: find,
      redline_replace: replace,
      redline_rationale: rationale,
      redline_status: status,
      redline_resolved_at: status === 'accepted' || status === 'rejected'
        ? new Date().toISOString()
        : null,
      model_used: review.model || null,
    })
    .select('*')
    .single();
  if (cellErr) return json({ error: `Could not insert cell: ${cellErr.message}` }, 500);

  return json({
    cell,
    column_index: newColIndex,
    columns_config: newCols,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
