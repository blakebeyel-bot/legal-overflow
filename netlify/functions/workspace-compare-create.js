/**
 * POST /api/workspace-compare-create
 *   body: {
 *     title,
 *     base_document_id,       // your template / preferred version
 *     proposed_document_id,   // the other side's draft
 *     client_role?, additional_context?, project_id?, model?
 *   }
 * Returns: { run_id }
 *
 * Creates a workspace_compare_runs row (pending) and fires the
 * background fanout. Client polls workspace-compare-get for status.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 200);
  const baseId = body.base_document_id;
  const proposedId = body.proposed_document_id;
  const model = String(body.model || 'claude-sonnet-4-5').slice(0, 100);
  const clientRole = body.client_role ? String(body.client_role).trim().slice(0, 200) : null;
  const additionalContext = body.additional_context ? String(body.additional_context).trim().slice(0, 4000) : null;
  const projectId = body.project_id || null;

  if (!title) return json({ error: 'Title required' }, 400);
  if (!baseId || !proposedId) return json({ error: 'Both base_document_id and proposed_document_id required' }, 400);
  if (baseId === proposedId) return json({ error: 'Base and proposed must be different documents' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership of both docs
  const { data: docs } = await supabase
    .from('workspace_documents')
    .select('id, original_filename')
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .in('id', [baseId, proposedId]);
  if ((docs || []).length !== 2) return json({ error: 'One or both documents not found' }, 400);

  const { data: run, error } = await supabase
    .from('workspace_compare_runs')
    .insert({
      user_id: auth.user.id,
      project_id: projectId,
      title,
      base_document_id: baseId,
      proposed_document_id: proposedId,
      client_role: clientRole,
      additional_context: additionalContext,
      model,
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);

  // Fire fanout
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  fetch(`${base}/.netlify/functions/workspace-compare-run-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: run.id, user_id: auth.user.id }),
  }).catch((err) => console.error('compare fanout fire failed:', err.message));

  return json({ run_id: run.id });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
