/**
 * POST /api/admin-trigger-rebuild
 *
 * Manually fire the Netlify Build Hook so the public site regenerates
 * (used after publishing or editing articles). Admin only.
 *
 * Requires the NETLIFY_BUILD_HOOK env var. Get the URL from:
 *   Netlify dashboard → Site settings → Build & deploy → Build hooks → Add build hook
 */
import { requireAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook) return json({ error: 'NETLIFY_BUILD_HOOK env var not set on server' }, 500);

  try {
    const r = await fetch(hook, { method: 'POST' });
    if (!r.ok) return json({ error: `Build hook returned HTTP ${r.status}` }, 500);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
