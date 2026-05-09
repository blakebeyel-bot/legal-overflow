/**
 * POST /api/workspace-vault-settings-update
 *   body: {
 *     vault_embedding_provider?: 'voyage' | 'openai' | 'gemini',
 *     vault_auto_ingest_uploads?: boolean,
 *     vault_auto_ingest_chats?: boolean,
 *     vault_auto_use_in_chats?: boolean,
 *   }
 *
 * Updates the user's vault preferences. If
 * vault_embedding_provider changed, fires the re-embed background
 * job so all of the user's chunks are re-embedded under the new
 * provider's column.
 *
 * Returns: { settings, reembed_kicked_off: boolean }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const VALID_PROVIDERS = new Set(['voyage', 'openai', 'gemini']);

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const patch = {};

  if (typeof body.vault_embedding_provider === 'string') {
    if (!VALID_PROVIDERS.has(body.vault_embedding_provider)) {
      return json({ error: 'Invalid provider' }, 400);
    }
    patch.vault_embedding_provider = body.vault_embedding_provider;
  }
  if (typeof body.vault_auto_ingest_uploads === 'boolean') patch.vault_auto_ingest_uploads = body.vault_auto_ingest_uploads;
  if (typeof body.vault_auto_ingest_chats   === 'boolean') patch.vault_auto_ingest_chats   = body.vault_auto_ingest_chats;
  if (typeof body.vault_auto_use_in_chats   === 'boolean') patch.vault_auto_use_in_chats   = body.vault_auto_use_in_chats;

  if (Object.keys(patch).length === 0) return json({ error: 'Nothing to update' }, 400);

  const supabase = getSupabaseAdmin();

  // Read current to detect provider change
  const { data: current } = await supabase
    .from('workspace_user_settings')
    .select('vault_embedding_provider')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  const prevProvider = current?.vault_embedding_provider || 'gemini';
  const willChangeProvider = patch.vault_embedding_provider && patch.vault_embedding_provider !== prevProvider;

  // Upsert settings
  const upsertRow = { user_id: auth.user.id, ...patch };
  const { data: settings, error } = await supabase
    .from('workspace_user_settings')
    .upsert(upsertRow, { onConflict: 'user_id' })
    .select('vault_embedding_provider, vault_auto_ingest_uploads, vault_auto_ingest_chats, vault_auto_use_in_chats')
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);

  let reembedKickedOff = false;
  if (willChangeProvider) {
    // Fire the re-embed background job. Don't await — it may run for
    // minutes if the user has lots of chunks.
    fireReembed({ userId: auth.user.id, newProvider: patch.vault_embedding_provider });
    reembedKickedOff = true;
  }

  return json({ settings, reembed_kicked_off: reembedKickedOff });
};

function fireReembed({ userId, newProvider }) {
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  const url = `${base}/.netlify/functions/workspace-vault-reembed-background`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'vault-settings-update' },
    body: JSON.stringify({ user_id: userId, new_provider: newProvider }),
  }).catch((err) => console.error('fireReembed failed:', err.message));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
