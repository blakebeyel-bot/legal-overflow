# Admin: approving signups + releasing downloads

Two access gates require manual operator action:

1. **Account approval** for the agents (contract-review, citation-verifier).
2. **Download approval** for Skills + Prompt-pack files.

Both are intentionally manual so the operator can run a basic conflict
check (Florida Rule 4-1.7 / 4-1.18) and screen requesters before
committing API credits or releasing materials.

---

## 0. One-time setup: make yourself an admin

The admin UI page at **`/admin/users/`** only works for accounts whose
profile row has `tier = 'admin'`. After running migration 0012, set
your own account to admin via Supabase SQL editor:

```sql
update public.profiles
   set tier = 'admin',
       approval_note = 'Site operator'
 where email = 'blake@beyelbrothers.com';
```

After that, log in at `/login/` and visit `/admin/users/` — the page
will load and you can manage everyone else from the UI.

---

## 1. Account approval (agents) — UI flow

Open **https://YOUR_DOMAIN/admin/users/**.

You'll see every signed-up user as a row. Each row shows:

- **Email** + truncated user ID
- **Status** — Pending or Approved (pending rows are highlighted)
- **Tier** — dropdown (trial / standard / pro / admin / enterprise)
- **Reviews (used / cap)** — current 30-day usage; per-user cap override field
- **Citations (used / cap)** — same shape
- **Joined** — signup date
- **Actions** — Approve button (pending users) or Revoke button (approved users)

### Approving a new user

Click the **Approve** button on their row. The endpoint sets
`approved_at = now()` and the user is immediately able to run agents
on their next page load. A toast confirms.

### Revoking access

Click **Revoke** on an approved user; confirm the dialog. The user is
immediately blocked from running new reviews; existing review history
is preserved.

### Per-user quota overrides

Type a number into the **cap override** input next to either Reviews
or Citations. Press Tab or click anywhere else — the value saves on
change. Leave blank to fall back to the tier default.

Defaults:
- trial: 3 reviews / 3 citations per 30 days
- standard: 25 / 25
- pro: 100 / 100
- admin: 9999 / 9999
- enterprise: ∞ / ∞

### Filtering + searching

The toolbar above the table has filter pills (All / Pending /
Approved) and a search box that filters by email.

### Fallback: SQL editor (if the UI is broken)

```sql
-- Pending users
select email, created_at from public.profiles where approved_at is null order by created_at desc;

-- Approve a user
update public.profiles set approved_at = now() where email = 'EMAIL';

-- Revoke
update public.profiles set approved_at = null where email = 'EMAIL';

-- Set per-user cap
update public.profiles set review_cap_override = 10 where email = 'EMAIL';
```

---

## 2. Download approval (Skills + Prompt packs)

### How requests come in

When a logged-out or logged-in user clicks any download link in
`/assets/skills/`, the modal asks for:

- Full name
- Email
- Are you a licensed attorney? (Y/N + jurisdictions if yes)
- Acknowledgment checkboxes (data handling + AI-use)

On submit, the request is captured by **Netlify Forms** under the form
name `downloads`. The user sees a "Request received, we'll email you
when approved" confirmation. **No file is delivered automatically.**

### How to see download requests

1. Open the Netlify dashboard for the site.
2. Site configuration → **Forms** → select `downloads`.
3. Each row is a request: name, email, attorney Y/N, jurisdictions,
   the file they wanted (`file` field), and the timestamp.

### How to release the download

For each approved request, send the user an email with the asset URL:

```
Subject: Your download is ready — [skill name]

Hi [Name],

Thanks for requesting access. Here's the file you asked for:

  https://YOUR_DOMAIN/assets/skills/[file-name].zip

Reminders:
- This file is not legal advice.
- AI output requires independent review before reliance.

— Blake Beyel
  Florida Bar No. 1065044 · Cocoa, FL
```

The asset URL itself is currently public (Netlify serves files from
`/public/assets/`). The gate is purely the modal — i.e., we trust the
request flow to discourage casual scraping while keeping admin
overhead low. If you later need stronger control:

- Move the assets to Supabase storage with signed URLs (per-request,
  time-limited).
- Or generate one-time download tokens via a Netlify function.

### How to enable an admin email notification on every request

Netlify Forms can email you automatically when a new submission lands.

1. Site settings → Forms → **Form notifications** → Add notification.
2. Type: **Email**.
3. Trigger: **New form submission**.
4. Form: `downloads`.
5. Email: `blake@beyelbrothers.com`.

Now every download request shows up in your inbox in real time.

---

## 3. Quick command reference

```sql
-- Pending users
select email, created_at from public.profiles where approved_at is null order by created_at desc;

-- Approve a user
update public.profiles set approved_at = now(), approval_note = 'Approved' where email = 'EMAIL';

-- Revoke approval
update public.profiles set approved_at = null, approval_note = 'Revoked: <reason>' where email = 'EMAIL';

-- Recently approved
select email, approved_at from public.profiles where approved_at > now() - interval '7 days' order by approved_at desc;
```
