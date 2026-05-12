/**
 * POST /api/microsoft-oauth-disconnect
 *
 * Removes the user's stored Microsoft refresh token. The user can
 * reconnect at any time by re-running /api/microsoft-oauth-start.
 *
 * Returns: { ok: true }
 */
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { deleteCreds } from '../lib/microsoft-graph.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  try {
    await deleteCreds(auth.user.id);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message || 'Disconnect failed' }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
