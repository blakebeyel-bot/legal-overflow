/**
 * Microsoft Graph integration — OAuth 2.0 (authorization code) + REST.
 *
 * Stores the encrypted refresh token per user on workspace_user_api_keys
 * (provider='microsoft'), then derives a short-lived access token on each
 * call. Access tokens are cached in-memory for 4 minutes to keep the
 * Graph round-trip count down.
 *
 * Required env vars:
 *   MSGRAPH_CLIENT_ID       — Application (client) ID from Azure portal
 *   MSGRAPH_TENANT_ID       — Directory (tenant) ID, or 'common' for
 *                             multi-tenant + personal accounts
 *   MSGRAPH_CLIENT_SECRET   — server-only client secret
 *   URL                     — site base URL (Netlify-supplied; used to
 *                             build the redirect URI in code)
 *
 * Optional:
 *   MSGRAPH_REDIRECT_URI    — override the auto-built redirect URI
 *
 * The Paralegal agent calls into these helpers via the broker (Phase 4):
 *   - listRecentMail()      — Outlook inbox, optional sender filter
 *   - getMessage()          — full message with attachment metadata
 *   - getAttachment()       — raw attachment bytes
 *   - listCalendarEvents()  — date-range events
 *   - sendMail()            — Phase 5 (read-only this phase)
 *   - createCalendarEvent() — Phase 5
 *   - createSharingLink()   — Phase 5
 */
import { getSupabaseAdmin } from './supabase-admin.js';
import { encryptForStorage, decryptFromStorage } from './encryption.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const OAUTH_AUTHORIZE = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const OAUTH_TOKEN = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

// Scopes — Phase 2 is read-only mail + calendar + read drive. Mail.Send
// + Calendars.ReadWrite are kept on the consent screen so we don't need
// a second consent prompt in Phase 5.
const SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'User.Read',
  'Mail.Read',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.Read.All',
].join(' ');

// ---- env access ----
export function isMicrosoftConfigured() {
  return !!(process.env.MSGRAPH_CLIENT_ID && process.env.MSGRAPH_TENANT_ID && process.env.MSGRAPH_CLIENT_SECRET);
}

function clientId() { return process.env.MSGRAPH_CLIENT_ID; }
function tenantId() { return process.env.MSGRAPH_TENANT_ID || 'common'; }
function clientSecret() { return process.env.MSGRAPH_CLIENT_SECRET; }

export function redirectUri() {
  if (process.env.MSGRAPH_REDIRECT_URI) return process.env.MSGRAPH_REDIRECT_URI;
  const base = process.env.URL
    || process.env.DEPLOY_PRIME_URL
    || 'http://localhost:8888';
  return `${base.replace(/\/$/, '')}/api/microsoft-oauth-callback`;
}

// ---- OAuth flow (PKCE) ----
// Microsoft requires PKCE for any cross-origin redirect (including
// http://localhost callbacks). Generate a 43+ char URL-safe verifier,
// SHA-256 it, base64url-encode the digest, and pass the result as
// code_challenge on /authorize. The verifier is embedded in the signed
// state token so the callback handler can supply it during code exchange.
import { createHash } from 'node:crypto';

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function pkceChallenge(codeVerifier) {
  return base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
}

export function buildAuthorizeUrl({ state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
    // Force consent + offline_access every time so refresh tokens are
    // always returned (Azure caches consent and skips it otherwise).
    prompt: 'consent',
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${OAUTH_AUTHORIZE(tenantId())}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code, { codeVerifier } = {}) {
  // OAuth auth codes are single-use — Azure consumes the code on the
  // FIRST /token call even when the response is an error. We can't
  // safely retry the same code with a different shape (client_secret
  // present vs absent).
  //
  // Strategy: try WITH secret first (Web/confidential is the default
  // for our app registration). If Azure rejects with "Client is public,
  // don't send secret" (AADSTS700025), retry without secret.
  const baseParams = {
    client_id: clientId(),
    code,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
    scope: SCOPES,
  };
  if (codeVerifier) baseParams.code_verifier = codeVerifier;

  let r = await fetch(OAUTH_TOKEN(tenantId()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...baseParams, client_secret: clientSecret() }).toString(),
  });
  let j = await r.json();

  // Public-client retry: only when Azure says client_secret is forbidden.
  if (!r.ok && j.error === 'invalid_client' && /client is public|AADSTS700025/i.test(j.error_description || '')) {
    r = await fetch(OAUTH_TOKEN(tenantId()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(baseParams).toString(),
    });
    j = await r.json();
  }

  if (!r.ok) {
    throw new Error(`MSGraph token exchange failed: ${j.error || r.status} — ${j.error_description || ''}`);
  }
  return j; // { access_token, refresh_token, expires_in, scope, token_type, id_token }
}

async function refreshAccessToken(refreshToken) {
  // Same secret-first pattern as exchangeCodeForTokens — secret comes
  // first because that's what our confidential-client registration
  // expects. Public-client retry only if Azure explicitly rejects.
  const baseParams = {
    client_id: clientId(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES,
  };
  let r = await fetch(OAUTH_TOKEN(tenantId()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...baseParams, client_secret: clientSecret() }).toString(),
  });
  let j = await r.json();
  if (!r.ok && j.error === 'invalid_client' && /client is public|AADSTS700025/i.test(j.error_description || '')) {
    r = await fetch(OAUTH_TOKEN(tenantId()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(baseParams).toString(),
    });
    j = await r.json();
  }
  if (!r.ok) {
    throw new Error(`MSGraph refresh failed: ${j.error || r.status} — ${j.error_description || ''}`);
  }
  return j;
}

// ---- token storage ----
async function getStoredCreds(userId) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_user_api_keys')
    .select('ciphertext, account_email')
    .eq('user_id', userId)
    .eq('provider', 'microsoft')
    .maybeSingle();
  if (error) throw new Error(`MSGraph creds lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    refreshToken: decryptFromStorage(data.ciphertext),
    accountEmail: data.account_email || null,
  };
}

export async function storeCreds(userId, { refreshToken, accountEmail }) {
  const supabase = getSupabaseAdmin();
  // Upsert by (user_id, provider). RLS allows the service role.
  const fingerprint = accountEmail ? accountEmail.split('@')[0].slice(-4) : 'msft';
  const { error } = await supabase
    .from('workspace_user_api_keys')
    .upsert(
      {
        user_id: userId,
        provider: 'microsoft',
        ciphertext: encryptForStorage(refreshToken),
        fingerprint,
        account_email: accountEmail,
      },
      { onConflict: 'user_id,provider' }
    );
  if (error) throw new Error(`MSGraph creds store failed: ${error.message}`);
}

export async function deleteCreds(userId) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('workspace_user_api_keys')
    .delete()
    .eq('user_id', userId)
    .eq('provider', 'microsoft');
  if (error) throw new Error(`MSGraph creds delete failed: ${error.message}`);
}

// ---- access-token cache (in-memory, 4-minute TTL) ----
const tokenCache = new Map(); // userId -> { token, exp }
const TOKEN_TTL_MS = 4 * 60 * 1000;

async function getAccessToken(userId) {
  const now = Date.now();
  const cached = tokenCache.get(userId);
  if (cached && cached.exp > now + 30_000) return cached.token;

  const creds = await getStoredCreds(userId);
  if (!creds) throw new Error('Microsoft 365 not connected for this user');
  const fresh = await refreshAccessToken(creds.refreshToken);
  // Refresh tokens rotate — persist the new one
  if (fresh.refresh_token && fresh.refresh_token !== creds.refreshToken) {
    await storeCreds(userId, {
      refreshToken: fresh.refresh_token,
      accountEmail: creds.accountEmail,
    });
  }
  tokenCache.set(userId, {
    token: fresh.access_token,
    exp: now + (Number(fresh.expires_in || 3600) * 1000),
  });
  return fresh.access_token;
}

// ---- generic Graph fetch ----
export async function graphFetch(userId, path, options = {}) {
  const token = await getAccessToken(userId);
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type'] && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, { ...options, headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let err;
    try { err = JSON.parse(text); } catch { err = { error: text }; }
    const code = err?.error?.code || err?.error_code || '';
    const message = err?.error?.message || err?.error_description || err?.error || (text || 'unknown');
    // Dump as much raw context as possible so we can see what Microsoft
    // is actually sending — useful for diagnosing 401s with empty bodies.
    const wwwAuth = r.headers.get('WWW-Authenticate') || '';
    const reqId = r.headers.get('request-id') || r.headers.get('client-request-id') || '';
    console.warn(`[graph] ${options.method || 'GET'} ${path}`);
    console.warn(`[graph]   status=${r.status} text_len=${text.length} request_id=${reqId}`);
    console.warn(`[graph]   www-authenticate: ${wwwAuth.slice(0, 400)}`);
    console.warn(`[graph]   body: ${text.slice(0, 600)}`);
    const out = new Error(`Graph ${options.method || 'GET'} ${path} failed: ${r.status} ${code ? `[${code}] ` : ''}— ${message || `body=${text.length}b www-auth=${wwwAuth.slice(0, 100)}`}`);
    out.status = r.status;
    out.code = code;
    out.body = text.slice(0, 1000);
    out.wwwAuthenticate = wwwAuth;
    throw out;
  }
  return r;
}

export async function graphJson(userId, path, options = {}) {
  const r = await graphFetch(userId, path, options);
  if (r.status === 204) return null;
  return r.json();
}

// ---- domain helpers ----

/** Returns the connected account's profile (email, displayName). */
export async function getMe(userId) {
  return graphJson(userId, '/me?$select=id,displayName,mail,userPrincipalName');
}

/**
 * List inbox messages — entire mailbox by keyword, no date cap by default.
 *
 * Two modes depending on what's provided:
 *
 *   1. `search` (or `from` treated as the search term when no `search`):
 *      uses Graph's `$search="..."` parameter to hit the FULL mailbox
 *      across subject + body + from + to + attachment names. Microsoft
 *      Graph forbids combining $search with $filter, so we run the
 *      search and post-filter results in app code if a date floor is
 *      needed. This is the "relevant to this matter" use case.
 *
 *   2. No search/from: returns the most recent inbox messages (default
 *      30-day window, configurable via `days` or `since`). This is the
 *      "what's in my inbox right now" use case for a fresh matter that
 *      doesn't have keywords yet.
 *
 * @param {object} opts
 * @param {string} [opts.search]      — keyword query; searches the entire inbox
 * @param {string} [opts.from]        — sender substring; used as $search term when no `search`
 * @param {string} [opts.since]       — ISO datetime floor (ignored when $search is in use)
 * @param {number} [opts.days]        — N days back (ignored when $search is in use)
 * @param {number} [opts.top=25]      — max results
 */
export async function listRecentMail(userId, { from, search, since, days, top = 25 } = {}) {
  const select = '$select=id,subject,from,toRecipients,sentDateTime,receivedDateTime,bodyPreview,hasAttachments,conversationId,internetMessageId,webLink';
  const limitedTop = Math.min(top, 50);

  // Use the keyword path when the caller wants matter-relevant mail
  // across the whole mailbox. `from` doubles as a search term when no
  // explicit `search` is supplied — that's how the matter detail page
  // expresses "mail relating to this matter" via counter_party.
  const keyword = search || from;
  if (keyword && String(keyword).trim()) {
    const q = [
      select,
      `$top=${limitedTop}`,
      `$search=${encodeURIComponent('"' + String(keyword).trim() + '"')}`,
    ].join('&');
    // Graph requires the ConsistencyLevel: eventual header for $search.
    const r = await graphFetch(userId, `/me/messages?${q}`, {
      headers: { ConsistencyLevel: 'eventual' },
    });
    const data = await r.json();
    return data?.value || [];
  }

  // Fallback (no keyword): plain recent-mail listing with date floor.
  const sinceIso = since
    || new Date(Date.now() - (days != null ? days : 30) * 24 * 60 * 60 * 1000).toISOString();
  const filter = `receivedDateTime ge ${sinceIso}`;
  const q = [
    select,
    `$top=${limitedTop}`,
    `$filter=${encodeURIComponent(filter)}`,
    '$orderby=receivedDateTime%20desc',
  ].join('&');
  const data = await graphJson(userId, `/me/mailFolders/inbox/messages?${q}`);
  return data?.value || [];
}

/** Full message with body + attachment metadata. */
export async function getMessage(userId, messageId) {
  const message = await graphJson(userId, `/me/messages/${messageId}?$select=id,subject,from,toRecipients,ccRecipients,sentDateTime,body,hasAttachments,conversationId,internetMessageId,webLink`);
  let attachments = [];
  if (message?.hasAttachments) {
    const list = await graphJson(userId, `/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`);
    attachments = list?.value || [];
  }
  return { message, attachments };
}

/**
 * Get attachment bytes. Returns { bytes, name, contentType, size }.
 * The endpoint shape: /me/messages/{id}/attachments/{aid}/$value returns
 * the raw bytes for fileAttachments.
 */
export async function getAttachment(userId, messageId, attachmentId) {
  const meta = await graphJson(userId, `/me/messages/${messageId}/attachments/${attachmentId}`);
  if (!meta) throw new Error('Attachment not found');
  // For fileAttachments, contentBytes is a base64 string in the metadata response.
  if (meta['@odata.type'] === '#microsoft.graph.fileAttachment' && meta.contentBytes) {
    return {
      bytes: Buffer.from(meta.contentBytes, 'base64'),
      name: meta.name,
      contentType: meta.contentType,
      size: meta.size,
    };
  }
  // For itemAttachments / referenceAttachments, the data path differs; we don't support those in Phase 2.
  throw new Error(`Unsupported attachment type: ${meta['@odata.type'] || 'unknown'}`);
}

/** Calendar events in a date range. */
export async function listCalendarEvents(userId, { start, end } = {}) {
  const startIso = start || new Date().toISOString();
  const endIso = end || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const select = '$select=id,subject,start,end,location,attendees,organizer,bodyPreview,webLink,isAllDay';
  const q = [
    select,
    `startDateTime=${encodeURIComponent(startIso)}`,
    `endDateTime=${encodeURIComponent(endIso)}`,
    '$orderby=start/dateTime',
    '$top=50',
  ].join('&');
  const data = await graphJson(userId, `/me/calendarView?${q}`);
  return data?.value || [];
}

// ---- Phase 5 stubs (outbound; intentionally throw in Phase 2) ----

export async function sendMail(userId, { to, cc, subject, body, replyToMessageId }) {
  // Placeholder — Phase 5 wires this up. Kept here so the broker tool
  // schema can reference the function name now.
  throw new Error('sendMail is not enabled until Phase 5');
}

export async function createCalendarEvent(userId, event) {
  throw new Error('createCalendarEvent is not enabled until Phase 5');
}

export async function createSharingLink(userId, driveItemId, { type = 'view' } = {}) {
  throw new Error('createSharingLink is not enabled until Phase 5');
}
