/**
 * GET /api/microsoft-debug
 *
 * Diagnostic-only endpoint. Probes the user's Microsoft Graph token
 * against three endpoints in increasing privilege:
 *   1. /me        — works for any signed-in account (no mailbox required)
 *   2. /me/mailboxSettings — works only when the account has an Outlook mailbox
 *   3. /me/messages?$top=1 — same as above plus Mail.Read scope check
 *
 * Returns the per-endpoint status code + truncated body so we can
 * tell exactly which check failed and why.
 */
import { requireUser, checkUserApproval, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { graphFetch } from '../lib/microsoft-graph.js';
import { decryptFromStorage } from '../lib/encryption.js';

export default async (req) => {
  // Accept Authorization header OR ?access_token= so browsers can hit it.
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('access_token');
  const authHeader = req.headers.get('Authorization')
    || (queryToken ? `Bearer ${queryToken}` : null);
  const auth = await requireUser(authHeader);
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  // ---- Inspect the stored creds row + an issued access token ----
  const supabase = getSupabaseAdmin();
  const { data: creds } = await supabase
    .from('workspace_user_api_keys')
    .select('account_email, created_at, updated_at')
    .eq('user_id', auth.user.id)
    .eq('provider', 'microsoft')
    .maybeSingle();

  // Mint a fresh access token + decode claims so we can see scope + aud
  let tokenInfo = null;
  try {
    // Trigger a fresh exchange via graphFetch hitting /me — but capture
    // the access token from the refresh endpoint directly for inspection.
    // Easiest: replay refreshAccessToken with our own copy.
    const { data: row } = await supabase
      .from('workspace_user_api_keys')
      .select('ciphertext')
      .eq('user_id', auth.user.id)
      .eq('provider', 'microsoft')
      .maybeSingle();
    if (row?.ciphertext) {
      const refresh = decryptFromStorage(row.ciphertext);
      const body = new URLSearchParams({
        client_id: process.env.MSGRAPH_CLIENT_ID,
        refresh_token: refresh,
        grant_type: 'refresh_token',
        scope: 'offline_access openid profile email User.Read Mail.Read Mail.Send Calendars.ReadWrite Files.Read.All',
      });
      const r = await fetch(`https://login.microsoftonline.com/${process.env.MSGRAPH_TENANT_ID || 'common'}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const j = await r.json();
      if (r.ok && j.access_token) {
        const claims = decodeJwtClaims(j.access_token);
        tokenInfo = {
          ok: true,
          expires_in: j.expires_in,
          scope_granted: j.scope || claims?.scp || '(none)',
          aud: claims?.aud,
          iss: claims?.iss,
          appid: claims?.appid,
          tid: claims?.tid,
          unique_name: claims?.unique_name || claims?.upn,
          ver: claims?.ver,
        };
      } else {
        tokenInfo = { ok: false, error: j.error, description: j.error_description };
      }
    }
  } catch (err) {
    tokenInfo = { exception: String(err.message || err) };
  }

  // ---- Run the three probes ----
  const probes = ['/me', '/me/mailboxSettings', '/me/messages?$top=1'];
  const probeResults = {};
  for (const path of probes) {
    try {
      const r = await graphFetch(auth.user.id, path);
      const text = await r.text();
      probeResults[path] = { status: r.status, body_preview: text.slice(0, 400) };
    } catch (err) {
      probeResults[path] = {
        status: err.status || 'throw',
        code: err.code || '',
        message: String(err.message || err).slice(0, 400),
        body: (err.body || '').slice(0, 400),
        www_authenticate: (err.wwwAuthenticate || '').slice(0, 400),
      };
    }
  }

  return json({
    user_id: auth.user.id,
    stored_account_email: creds?.account_email || null,
    token_info: tokenInfo,
    probes: probeResults,
  });
};

function decodeJwtClaims(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
