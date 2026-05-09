/**
 * POST /api/workspace-vault-reembed-background
 *   body: { user_id, new_provider }
 *
 * Background function (-background suffix → up to 15 min on
 * Netlify). Re-embeds every chunk in the user's vault under the new
 * provider, populating the matching vector column and clearing the
 * others. Triggered by workspace-vault-settings-update when the
 * embedding provider changes.
 *
 * Internal — invoked only via fire-and-forget from the settings
 * update endpoint, with X-Internal-Trigger header. We don't expose
 * any auth on the body itself; the caller is the same Netlify
 * deployment.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { reembedAllForUser } from '../lib/vault.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const userId      = body.user_id;
  const newProvider = body.new_provider;
  if (!userId || !newProvider) {
    return new Response('missing user_id or new_provider', { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  try {
    const { reembeddedItems } = await reembedAllForUser({ supabase, userId, newProvider });
    console.log(`[vault-reembed] user=${userId} provider=${newProvider} items=${reembeddedItems}`);
    return new Response(JSON.stringify({ ok: true, items: reembeddedItems }));
  } catch (err) {
    console.error('[vault-reembed] failed:', err);
    return new Response('failed: ' + (err.message || err), { status: 500 });
  }
};
