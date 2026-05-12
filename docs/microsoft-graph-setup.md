# Microsoft 365 (Graph) setup — Paralegal Phase 2

The Paralegal voice agent reads from a user's Outlook inbox + Microsoft Calendar (Phase 2) and writes back (Phase 5: send email, create calendar invite, share doc) via Microsoft Graph. This requires a one-time Azure AD app registration.

## Steps (do this once per environment — dev and prod)

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **+ New registration**.
2. **Name**: `Legal Overflow Paralegal` (or anything you want; users see this on the consent screen).
3. **Supported account types**: pick "**Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts (e.g., Skype, Xbox)**". This lets both work accounts and personal `@outlook.com` / `@hotmail.com` accounts connect.
4. **Redirect URI** (Web):
   - Production: `https://legaloverflow.com/api/microsoft-oauth-callback`
   - Local dev: `http://localhost:8888/api/microsoft-oauth-callback`
   Add both via "+ Add a Redirect URI" after creation if needed.
5. Click **Register**.

### Copy the IDs
On the new app's Overview page, copy:
- **Application (client) ID** → this becomes `MSGRAPH_CLIENT_ID`
- **Directory (tenant) ID** → this becomes `MSGRAPH_TENANT_ID` (or use the literal string `common` for multi-tenant + personal accounts; we already pass `common` by default if `MSGRAPH_TENANT_ID` is unset)

### Create a client secret
1. Left sidebar → **Certificates & secrets** → **Client secrets** → **+ New client secret**.
2. Description: `lo-paralegal-prod` (or `dev`).
3. Expires: 24 months recommended (set a calendar reminder to rotate).
4. **Copy the Value field immediately** — Azure shows it only once. This becomes `MSGRAPH_CLIENT_SECRET`.

### Add Graph API permissions
1. Left sidebar → **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions** (NOT Application — these are per-user delegated scopes).
2. Add all of:
   - `offline_access` — required to get refresh tokens
   - `openid`
   - `profile`
   - `email`
   - `User.Read`
   - `Mail.Read` — Phase 2
   - `Mail.Send` — Phase 5 (added now so users don't see a second consent prompt later)
   - `Calendars.ReadWrite` — Phase 2 read, Phase 5 write
   - `Files.Read.All` — for attachment downloads
3. **Grant admin consent** if you're admin for your tenant. Otherwise users will consent individually on first connection.

## Netlify env vars

In your Netlify site settings → Environment variables, add:

| Name | Value |
|---|---|
| `MSGRAPH_CLIENT_ID` | Application (client) ID from step above |
| `MSGRAPH_TENANT_ID` | `common` (recommended for multi-tenant + personal) OR your specific tenant ID |
| `MSGRAPH_CLIENT_SECRET` | client secret value |
| `MSGRAPH_REDIRECT_URI` | *(optional)* override; defaults to `${URL}/api/microsoft-oauth-callback` |

Restart your Netlify dev server / redeploy after adding.

## Test the connection

1. Sign in on the site.
2. Go to `/account/` → scroll to **Microsoft 365** section.
3. Click **Connect Microsoft 365**.
4. You'll be sent to login.microsoftonline.com → sign in with the account you want to connect → grant consent.
5. You should land back on `/account/?msft=connected` with a green banner.
6. The state should switch to `CONNECTED · jane@firm.com` (or whichever account).
7. Open `/agents/paralegal/matters/` → click into any matter → the activity timeline on the matter detail page should now show your recent Outlook inbox messages and upcoming calendar events interleaved with audit events.

## Disconnecting

Click the **Disconnect** button on `/account/`. This removes the encrypted refresh token from `workspace_user_api_keys`. To fully revoke from Microsoft's side too, visit [https://account.live.com/consent/manage](https://account.live.com/consent/manage) (personal) or your tenant's enterprise apps settings (work account).

## Token security

- Refresh tokens are AES-256-GCM encrypted at rest using `BYOK_ENCRYPTION_KEY` (same key the rest of BYOK uses).
- Access tokens are cached in-memory only (4-minute TTL); never persisted.
- Compromising the database alone does **not** leak any Microsoft tokens — an attacker also needs the encryption key from Netlify env.
- Refresh tokens rotate on each refresh — Azure issues a new refresh token along with each access token, and we re-encrypt + persist it.

## Cost & rate-limiting

Microsoft Graph delegated calls are free within Microsoft's standard throttling (10,000 requests per app per 10 min per tenant for most endpoints). The Paralegal's typical session triggers 5–20 Graph calls; far below the limit.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/microsoft-oauth-start` returns 503 | env vars missing | Set the three env vars in Netlify; redeploy |
| Consent screen returns `error=invalid_grant` | redirect URI mismatch | Verify the URI in Azure app exactly matches `${URL}/api/microsoft-oauth-callback` |
| Status shows `NOT CONNECTED` immediately after consent | refresh token not returned | Ensure `offline_access` scope is in API permissions; the OAuth start enforces `prompt=consent` to always include it |
| Mail / Calendar endpoints return 412 with `not_connected: true` | refresh token expired or revoked | User clicks Connect again on `/account/` |
| Graph returns 401 on every call | client secret rotated or expired | Generate a new secret in Azure, update `MSGRAPH_CLIENT_SECRET`, redeploy |

## Next phases

- **Phase 5** flips on `Mail.Send` and `Calendars.ReadWrite` write usage (already in the scope list — no second consent needed).
- **Phase 6** adds a settings entry to control whether the agent can read across the user's full inbox or only matter-tagged threads.
