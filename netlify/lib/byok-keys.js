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

const SERVER_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
};

export async function resolveProviderKey({ userId, provider }) {
  if (!SERVER_KEY_ENV[provider]) {
    return { key: null, source: 'none', error: `Unknown provider: ${provider}` };
  }

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
  const serverKey = process.env[SERVER_KEY_ENV[provider]];
  if (serverKey) return { key: serverKey, source: 'server' };

  return { key: null, source: 'none' };
}
