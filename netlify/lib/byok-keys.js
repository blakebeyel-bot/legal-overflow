/**
 * BYOK API key resolver.
 *
 * resolveProviderKey({ userId, provider }) returns the API key to use
 * for a given LLM provider, in priority order:
 *
 *   1. The user's own stored key (decrypted) if they've added one.
 *   2. The site-wide fallback env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *      GOOGLE_AI_API_KEY).
 *   3. null if neither exists — caller must surface a clear error.
 *
 * Returns { key, source } where source is 'user' | 'server' | 'none'.
 * The 'source' field is useful so the UI can display "using your key"
 * vs "using site key" hints.
 */
import { getSupabaseAdmin } from './supabase-admin.js';
import { decryptFromStorage } from './encryption.js';

// Netlify's AI Gateway auto-injects ANTHROPIC_API_KEY and OPENAI_API_KEY
// with JWT proxy tokens that fail 401 against the providers' APIs
// directly. We read the LO_-prefixed direct keys first, and fall back
// to the bare names only when the value matches a real provider key
// prefix. Same pattern as netlify/lib/anthropic.js and the citation
// verifier.
const SERVER_KEY_ENV = {
  anthropic: ['LO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai: ['LO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  google: ['GOOGLE_AI_API_KEY'],
  xai: ['XAI_API_KEY'],
};

function pickServerKey(provider) {
  const candidates = SERVER_KEY_ENV[provider] || [];
  for (const name of candidates) {
    const v = process.env[name];
    if (!v) continue;
    // Skip Netlify AI-Gateway JWT proxies. Real provider keys start
    // with recognizable prefixes; anything else is a Gateway token.
    if (provider === 'anthropic' && !v.startsWith('sk-ant-')) continue;
    if (provider === 'openai'    && !v.startsWith('sk-'))     continue;
    if (provider === 'google'    && !v.startsWith('AIza'))    continue;
    if (provider === 'xai'       && !v.startsWith('xai-'))    continue;
    return v;
  }
  return null;
}

export async function resolveProviderKey({ userId, provider }) {
  if (!SERVER_KEY_ENV[provider]) {
    return { key: null, source: 'none', error: `Unknown provider: ${provider}` };
  }
  // ---- 0. (in legacy code below) try user BYOK first, then fall back ----

  // 1. Try user's stored BYOK key first.
  if (userId) {
    try {
      const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from('workspace_user_api_keys')
        .select('ciphertext')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();
      if (data?.ciphertext) {
        try {
          const key = decryptFromStorage(data.ciphertext);
          return { key, source: 'user' };
        } catch (decryptErr) {
          // Bad ciphertext (rotated key? corrupted row?). Fall through
          // to server key but log the issue.
          console.error('byok decrypt failed for user', userId, provider, decryptErr.message);
        }
      }
    } catch (err) {
      console.error('byok lookup failed', err);
    }
  }

  // 2. Fall back to server-wide env var.
  const serverKey = pickServerKey(provider);
  if (serverKey) return { key: serverKey, source: 'server' };

  return { key: null, source: 'none' };
}
