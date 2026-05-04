/**
 * GET /api/workspace-byok-list
 * Returns: { keys: [{ provider, fingerprint, updated_at }] }
 *
 * NEVER returns plaintext or ciphertext. Only the provider + last-4
 * fingerprint so the UI can show "key ending in ...xyz9" without
 * exposing the actual key.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_user_api_keys')
    .select('provider, fingerprint, updated_at')
    .eq('user_id', auth.user.id);
  if (error) return json({ error: error.message }, 500);
  return json({ keys: data || [] });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
