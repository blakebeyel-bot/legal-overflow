/**
 * POST /api/workspace-library-rename
 *   body: { id, filename }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  if (!body.id) return json({ error: 'Missing id' }, 400);
  const filename = String(body.filename || '').trim().slice(0, 255);
  if (!filename) return json({ error: 'Empty filename' }, 400);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_documents')
    .update({ filename })
    .eq('id', body.id)
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, filename });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
