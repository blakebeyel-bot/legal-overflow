/**
 * GET /api/microsoft-oauth-start
 *
 * Begins the Microsoft 365 OAuth flow with PKCE.
 *
 * - Authenticates the user via the Supabase session JWT (Authorization
 *   header OR ?access_token=<jwt> for plain-link navigation).
 * - Generates a PKCE code_verifier (43+ char URL-safe random) and
 *   derives code_challenge = base64url(SHA256(code_verifier)).
 * - Builds a signed state token containing user_id + nonce + ts +
 *   code_verifier. The state is round-tripped to Microsoft and back, so
 *   the callback handler can recover the verifier without server-side
 *   session storage.
 * - 302-redirects to login.microsoftonline.com.
 *
 * PKCE is required by Microsoft for cross-origin callbacks (including
 * http://localhost), per error AADSTS9002325.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { buildAuthorizeUrl, isMicrosoftConfigured, pkceChallenge } from '../lib/microsoft-graph.js';

export default async (req) => {
  if (!isMicrosoftConfigured()) {
    return new Response('Microsoft Graph not configured — missing env vars', { status: 503 });
  }

  // Allow either Authorization header OR ?access_token= query (a plain
  // <a href> from /account/ can't set headers across a top-level nav).
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('access_token');
  const authHeader = req.headers.get('Authorization')
    || (queryToken ? `Bearer ${queryToken}` : null);
  const auth = await requireUser(authHeader);
  if (auth.error) return new Response(auth.error, { status: auth.status });
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return new Response('Account pending approval', { status: 403 });

  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret) return new Response('BYOK_ENCRYPTION_KEY env var not set', { status: 500 });

  // PKCE code_verifier — 64 bytes of URL-safe base64 (~86 chars). Per
  // RFC 7636 the verifier must be 43-128 chars, URL-safe-alphabet.
  const codeVerifier = randomBytes(48).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const codeChallenge = pkceChallenge(codeVerifier);

  // Signed state: user_id . nonce . ts . codeVerifier. The verifier
  // lives inside HMAC-protected state so an attacker can't substitute
  // their own. The payload is base64url'd so a `.` separator stays
  // unambiguous against the verifier's own URL-safe charset (no `.`).
  const nonce = randomBytes(16).toString('base64url');
  const ts = Date.now();
  const payload = `${auth.user.id}.${nonce}.${ts}.${codeVerifier}`;
  const payloadEncoded = Buffer.from(payload).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadEncoded).digest('base64url');
  const state = `${payloadEncoded}.${sig}`;

  const redirectUrl = buildAuthorizeUrl({ state, codeChallenge });
  return new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  });
};
