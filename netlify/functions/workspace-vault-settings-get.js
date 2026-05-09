/**
 * GET /api/workspace-vault-settings-get
 *
 * Returns the user's vault preferences:
 *   - vault_embedding_provider ('voyage' | 'openai' | 'gemini')
 *   - vault_auto_ingest_uploads (bool)
 *   - vault_auto_ingest_chats (bool)
 *   - vault_auto_use_in_chats (bool)
 *
 * If the row doesn't exist yet (first-time use), creates it with
 * defaults and returns those.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const DEFAULTS = {
  vault_embedding_provider: 'gemini',
  vault_auto_ingest_uploads: true,
  vault_auto_ingest_chats: false,
  vault_auto_use_in_chats: true,
};

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('workspace_user_settings')
    .select('vault_embedding_provider, vault_auto_ingest_uploads, vault_auto_ingest_chats, vault_auto_use_in_chats')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!data) {
    await supabase.from('workspace_user_settings').insert({ user_id: auth.user.id });
    return json({ settings: { ...DEFAULTS } });
  }
  return json({ settings: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
