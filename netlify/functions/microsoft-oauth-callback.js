/**
 * GET /api/microsoft-oauth-callback?code=...&state=...
 *
 * Microsoft redirects back to this endpoint after the user grants
 * consent. We verify the signed state token, exchange the auth code for
 * tokens, fetch the user's profile to capture the connected email, and
 * persist the encrypted refresh token + email.
 *
 * On success: 302-redirect to /account/?msft=connected so the user lands
 * back on the account page with a confirmation banner.
 *
 * Note: this endpoint cannot use `requireUser` because Microsoft's
 * redirect strips Authorization headers. We rely on the signed state
 * token instead.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  exchangeCodeForTokens,
  getMe,
  storeCreds,
  isMicrosoftConfigured,
} from '../lib/microsoft-graph.js';

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export default async (req) => {
  if (!isMicrosoftConfigured()) {
    return new Response('Microsoft Graph not configured', { status: 503 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  if (error) {
    console.warn(`[msoauth-callback] Microsoft returned error: ${error} — ${errorDesc}`);
    return redirect('/account/?msft=denied');
  }
  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // ---- Verify the signed state token ----
  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret) return new Response('BYOK_ENCRYPTION_KEY not set', { status: 500 });

  let userId, ts, codeVerifier;
  try {
    const [payloadEncoded, sig] = state.split('.');
    if (!payloadEncoded || !sig) throw new Error('Malformed state');
    const expected = createHmac('sha256', secret).update(payloadEncoded).digest('base64url');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new Error('Signature mismatch');
    }
    const payload = Buffer.from(payloadEncoded, 'base64url').toString();
    const parts = payload.split('.');
    // Format: user_id . nonce . ts . code_verifier
    if (parts.length < 4) throw new Error('Bad state payload shape');
    const [uid, , tsStr, ...verifierParts] = parts;
    const age = Date.now() - Number(tsStr || 0);
    if (age > STATE_MAX_AGE_MS) throw new Error('State token expired');
    userId = uid;
    ts = Number(tsStr);
    // Verifier may contain `.` if base64-padding ever returned (it won't
    // because we strip), but join the tail just to be safe.
    codeVerifier = verifierParts.join('.');
    if (!codeVerifier || codeVerifier.length < 43) throw new Error('Bad code_verifier');
  } catch (err) {
    console.warn(`[msoauth-callback] state validation failed: ${err.message}`);
    return new Response('Invalid state', { status: 400 });
  }

  // ---- Exchange code for tokens (with PKCE) ----
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, { codeVerifier });
  } catch (err) {
    console.error(`[msoauth-callback] token exchange failed: ${err.message}`);
    return redirect('/account/?msft=error');
  }

  if (!tokens.refresh_token) {
    // Should not happen with offline_access + prompt=consent, but guard.
    console.error('[msoauth-callback] no refresh_token in response');
    return redirect('/account/?msft=no_refresh');
  }

  // ---- Fetch profile so we can show "Connected · jane@firm.com" ----
  let accountEmail = null;
  try {
    // We need an access token to call /me. Use the freshly returned one.
    const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (r.ok) {
      const me = await r.json();
      accountEmail = me.mail || me.userPrincipalName || null;
    }
  } catch (err) {
    console.warn(`[msoauth-callback] profile lookup failed: ${err.message}`);
    // Non-fatal — proceed with the token store.
  }

  // ---- Persist (encrypted) ----
  try {
    await storeCreds(userId, {
      refreshToken: tokens.refresh_token,
      accountEmail,
    });
  } catch (err) {
    console.error(`[msoauth-callback] storeCreds failed: ${err.message}`);
    return redirect('/account/?msft=store_failed');
  }

  console.log(`[msoauth-callback] connected user=${userId} email=${accountEmail || 'unknown'}`);
  return redirect('/account/?msft=connected');
};

function redirect(path) {
  return new Response(null, { status: 302, headers: { Location: path } });
}
