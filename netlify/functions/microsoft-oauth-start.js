/**
 * GET /api/microsoft-oauth-start
 *
 * Begins the Microsoft 365 OAuth flow. Authenticates the user via the
 * Supabase session JWT (passed as Bearer in the Authorization header
 * OR as ?access_token=<jwt> if a same-tab redirect can't set headers).
 * Builds a CSRF-protected state token (signed JWT-ish with HMAC of
 * user_id + nonce + timestamp), embeds it in the Microsoft authorize URL,
 * and 302-redirects the browser.
 *
 * On callback, microsoft-oauth-callback verifies the state token and
 * exchanges the code for tokens.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { buildAuthorizeUrl, isMicrosoftConfigured } from '../lib/microsoft-graph.js';

export default async (req) => {
  if (!isMicrosoftConfigured()) {
    return new Response('Microsoft Graph not configured — missing env vars', { status: 503 });
  }

  // Allow either Authorization header OR ?access_token= query (so a plain
  // <a href> click from the account page works without custom JS).
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('access_token');
  const authHeader = req.headers.get('Authorization')
    || (queryToken ? `Bearer ${queryToken}` : null);
  const auth = await requireUser(authHeader);
  if (auth.error) return new Response(auth.error, { status: auth.status });
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return new Response('Account pending approval', { status: 403 });

  // Build a signed state token so the callback can verify the user.
  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret) return new Response('BYOK_ENCRYPTION_KEY env var not set', { status: 500 });
  const nonce = randomBytes(16).toString('base64url');
  const ts = Date.now();
  const payload = `${auth.user.id}.${nonce}.${ts}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  const state = `${Buffer.from(payload).toString('base64url')}.${sig}`;

  const redirectUrl = buildAuthorizeUrl({ state });
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
};
