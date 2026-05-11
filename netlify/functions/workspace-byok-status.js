/**
 * GET /api/workspace-byok-status
 *
 * Per-provider key-source map for the workspace UI's "KEYS" pill.
 * For each BYOK-eligible provider returns:
 *   - source: 'user' | 'server' | 'none'
 *   - fingerprint (last-4 of user's key) when source === 'user'
 *
 * NEVER returns plaintext or ciphertext — same safety posture as
 * workspace-byok-list. Fingerprints come from the existing
 * workspace_user_api_keys.fingerprint column.
 *
 * Performance: ONE DB query (vs. one per provider via resolveProviderKey).
 * Source is computed locally because we only need a yes/no, not the key.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai',    label: 'OpenAI (GPT)' },
  { id: 'google',    label: 'Google AI (Gemini)' },
  { id: 'xai',       label: 'xAI (Grok)' },
  { id: 'voyage',    label: 'Voyage (Embeddings)' },
];

// Mirrors the SERVER_KEY_ENV map in netlify/lib/byok-keys.js but only
// inspects env presence — no decryption, no DB. Same prefix gating to
// skip Netlify AI-Gateway JWT proxies that injected into the bare env
// names.
const SERVER_KEY_ENV = {
  anthropic: ['LO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai:    ['LO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  google:    ['GOOGLE_AI_API_KEY'],
  xai:       ['XAI_API_KEY'],
  voyage:    ['VOYAGE_API_KEY'],
};

function hasServerKey(provider) {
  for (const name of SERVER_KEY_ENV[provider] || []) {
    const v = process.env[name];
    if (!v) continue;
    if (provider === 'anthropic' && !v.startsWith('sk-ant-')) continue;
    if (provider === 'openai'    && !v.startsWith('sk-'))     continue;
    if (provider === 'google'    && !v.startsWith('AIza'))    continue;
    if (provider === 'xai'       && !v.startsWith('xai-'))    continue;
    return true;
  }
  return false;
}

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const supabase = getSupabaseAdmin();
  const { data: rows, error: dbErr } = await supabase
    .from('workspace_user_api_keys')
    .select('provider, fingerprint')
    .eq('user_id', auth.user.id);
  if (dbErr) return json({ error: dbErr.message }, 500);
  const fpMap = new Map((rows || []).map((r) => [r.provider, r.fingerprint]));

  const providers = PROVIDERS.map((p) => {
    if (fpMap.has(p.id)) {
      return { id: p.id, label: p.label, source: 'user', fingerprint: fpMap.get(p.id) };
    }
    return { id: p.id, label: p.label, source: hasServerKey(p.id) ? 'server' : 'none' };
  });

  return json({ providers });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
