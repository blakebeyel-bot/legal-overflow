/**
 * POST /api/workspace-redline-create
 *   body: { document_id, concerns, model? }
 * Returns: { run_id }
 *
 * Creates a workspace_redline_runs row in pending state and fires the
 * background fanout. Client polls workspace-redline-status with the
 * run_id until status='complete' or 'error'.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const documentId = body.document_id;
  const concerns = String(body.concerns || '').trim();
  const model = String(body.model || 'claude-sonnet-4-5').slice(0, 100);
  if (!documentId) return json({ error: 'Missing document_id' }, 400);
  if (!concerns) return json({ error: 'Concerns text required' }, 400);
  if (concerns.length > 8000) return json({ error: 'Concerns text too long' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership + that it's a .docx (we can only redline Word files)
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('id, original_filename')
    .eq('id', documentId)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!doc) return json({ error: 'Document not found' }, 404);
  if (!doc.original_filename?.toLowerCase().endsWith('.docx')) {
    return json({ error: 'Redlining requires a .docx file. PDFs and other formats not supported yet.' }, 400);
  }

  const { data: run, error } = await supabase
    .from('workspace_redline_runs')
    .insert({ user_id: auth.user.id, document_id: documentId, concerns, model, status: 'pending' })
    .select('*')
    .single();
  if (error) return json({ error: error.message }, 500);

  // Fire background fanout (best-effort). The background function
  // gates on X-Internal-Trigger so external callers can't trigger
  // redline pipelines with arbitrary run_id/user_id pairs.
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  fetch(`${base}/.netlify/functions/workspace-redline-run-background`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Trigger': 'redline-run',
    },
    body: JSON.stringify({ run_id: run.id, user_id: auth.user.id }),
  }).catch((err) => console.error('redline fanout fire failed:', err.message));

  return json({ run_id: run.id });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
