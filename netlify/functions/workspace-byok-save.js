/**
 * POST /api/workspace-byok-save
 *   body: { provider: 'anthropic'|'openai'|'google', api_key: string }
 * Encrypts and stores. Upserts on (user_id, provider).
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { encryptForStorage, fingerprintForDisplay } from '../lib/encryption.js';

const VALID = new Set(['anthropic', 'openai', 'google', 'xai']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const provider = String(body.provider || '').toLowerCase();
  const apiKey = String(body.api_key || '').trim();
  if (!VALID.has(provider)) return json({ error: 'Invalid provider' }, 400);
  if (apiKey.length < 8) return json({ error: 'API key too short' }, 400);
  if (apiKey.length > 500) return json({ error: 'API key too long' }, 400);

  let ciphertext;
  try {
    ciphertext = encryptForStorage(apiKey);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
  const fingerprint = fingerprintForDisplay(apiKey);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_user_api_keys')
    .upsert(
      { user_id: auth.user.id, provider, ciphertext, fingerprint },
      { onConflict: 'user_id,provider' }
    );
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, provider, fingerprint });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
