-- 0028_security_hardening.sql
--
-- Lock down two RLS exposures discovered during the site-wide audit:
--
--   1. profiles.tier / approved_at / *_cap_override are client-mutable.
--      The original profiles_self_update policy (migration 0001) used
--      `for update using (auth.uid() = id)` with NO `with check` clause,
--      so any logged-in user could `update profiles set tier='admin'`
--      from their browser console and self-promote to the highest quota
--      tier. This was the same SQL we ran from the Supabase admin UI to
--      bypass the trial cap during testing — it works equally well from
--      a logged-in browser today.
--
--      Fix: replace the policy with one that pins those columns to
--      their existing values via WITH CHECK. End-users can still update
--      their email and any future user-mutable column. Server functions
--      mutate `tier` / `approved_at` / cap-overrides via the service
--      role (which bypasses RLS), so admin promotion / approval flows
--      via /admin/users/ keep working unchanged.
--
--   2. workspace_user_api_keys.ciphertext is readable by the row owner.
--      The plaintext API key never reaches the browser today, but the
--      AES-256-GCM ciphertext does, because the SELECT policy doesn't
--      restrict columns. Defense-in-depth: revoke direct SELECT on
--      `ciphertext` from the `authenticated` role. The schema stores
--      `iv || authtag || ciphertext` as a single base64 blob in the
--      ciphertext column (no separate iv column), so revoking that one
--      column closes the whole exfiltration surface. The legitimate
--      reader (workspace-byok-list.js) only ever requests `provider,
--      fingerprint, updated_at`, so this is functionally a no-op for
--      the UI while closing off `await supabase.from(
--      'workspace_user_api_keys').select('ciphertext')` from the
--      browser console / a hypothetical XSS bug.
--
-- Safe to re-run; uses drop-if-exists + create.

-- ============================================================
-- Part 1 — profiles: column-locked update policy
-- ============================================================

drop policy if exists "profiles_self_update" on public.profiles;

-- The WITH CHECK clause references the OLD row via a subquery against
-- the same table. Postgres evaluates the subquery for the row being
-- written, so this effectively says "the columns I list MUST equal the
-- value already stored before this update". Service-role writes bypass
-- RLS entirely, so admin / approval mutations through
-- /admin/users/ continue to work via getSupabaseAdmin().
create policy "profiles_self_update" on public.profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- Lock tier — only the service role may promote.
    and tier = (select tier from public.profiles where id = auth.uid())
    -- Lock approval gate — only the service role may approve.
    and approved_at is not distinct from
        (select approved_at from public.profiles where id = auth.uid())
    and approval_note is not distinct from
        (select approval_note from public.profiles where id = auth.uid())
    -- Lock cap overrides — only the service role may bump them.
    and review_cap_override is not distinct from
        (select review_cap_override from public.profiles where id = auth.uid())
    and citation_cap_override is not distinct from
        (select citation_cap_override from public.profiles where id = auth.uid())
  );

comment on policy "profiles_self_update" on public.profiles is
  'Owner can update their own row, but tier / approved_at / approval_note / *_cap_override are pinned to their existing values via WITH CHECK. Promotions and approvals happen exclusively through service-role-authenticated server functions (admin endpoints under /netlify/functions/admin-*). See migration 0028 for rationale.';

-- ============================================================
-- Part 2 — workspace_user_api_keys: hide ciphertext from browsers
-- ============================================================
--
-- PostgREST honors column-level GRANTs. Revoke ciphertext + iv from
-- the `authenticated` role so logged-in users querying via supabase-js
-- can never receive those bytes; the service role retains full access
-- (servers decrypt + use the key to call provider APIs).

revoke select (ciphertext) on public.workspace_user_api_keys from authenticated;
-- Defensive: also revoke from anon (already had nothing under RLS, but
-- belt-and-suspenders).
revoke select (ciphertext) on public.workspace_user_api_keys from anon;

-- Re-grant the safe columns explicitly so the SELECT policy on the
-- table (created in migration 0014) still resolves to a working query
-- when the client asks for these columns.
grant select (id, user_id, provider, fingerprint, created_at, updated_at)
  on public.workspace_user_api_keys
  to authenticated;

comment on table public.workspace_user_api_keys is
  'BYOK API keys, AES-256-GCM ciphertext. Phase 1. (0028) Column-level GRANT now hides the ciphertext column from authenticated role; only service_role can read it. The ciphertext column stores `base64(iv || authtag || ciphertext)` as a single blob — revoking just that one column closes the whole exfiltration surface. Decryption happens exclusively in server functions (netlify/lib/byok-keys.js).';
