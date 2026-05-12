/**
 * GET /api/microsoft-oauth-status
 *
 * Returns the user's Microsoft 365 connection state.
 *
 * Response:
 *   { configured: boolean,                            // env vars present site-wide
 *     connected: boolean,
 *     account_email?: string,
 *     connected_at?: timestamp }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { isMicrosoftConfigured } from '../lib/microsoft-graph.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_user_api_keys')
    .select('account_email, created_at, updated_at')
    .eq('user_id', auth.user.id)
    .eq('provider', 'microsoft')
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);

  return json({
    configured: isMicrosoftConfigured(),
    connected: !!data,
    account_email: data?.account_email || null,
    connected_at: data?.updated_at || data?.created_at || null,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
