-- Round 9 — manual approval gate for new signups.
--
-- Why: open signup creates several Florida Bar exposures at once:
--   - Rule 4-1.7 / 4-1.18: every uploaded contract is potentially a
--     prospective-client matter, with no chance to run a conflict check.
--   - Rule 4-1.1 (competence + supervision): you're committing API
--     credits and your bar credentials to documents from people you
--     haven't vetted.
--   - Rule 4-5.5 (UPL): non-attorneys in other states could use the
--     contract-review agent thinking it's legal services.
-- Adding an approval gate lets the operator (Blake) review each signup
-- before that user can run any agent that costs money or processes a
-- third-party document.
--
-- Behavior:
--   - New users land in the pending state (approved_at is null).
--   - The contract-review and citation-verifier UIs detect this and
--     show a "your account is awaiting approval" panel instead of the
--     upload form.
--   - The /api/start-review and /api/verify-citations-start endpoints
--     reject pending users with a 403.
--   - Profile management, configurator chat, and the public tracker
--     stay open — pending users can prep their playbook so they're
--     ready when approved.
--
-- Migration is safe to re-run; existing users are auto-approved so
-- nobody currently signed in is locked out.

-- Widen the tier check constraint to include 'admin'. Migration 0001
-- only allowed trial / standard / pro / enterprise, which makes the
-- /admin/users/ admin tier impossible to set without dropping the
-- constraint first.
alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles add constraint profiles_tier_check
  check (tier in ('trial', 'standard', 'pro', 'admin', 'enterprise'));

alter table public.profiles
  add column if not exists approved_at timestamptz,
  add column if not exists approval_note text,
  add column if not exists review_cap_override integer,
  add column if not exists citation_cap_override integer;

comment on column public.profiles.approved_at is
  'Timestamp at which the operator approved this account for agent use. Null = pending. Once set, the user can run start-review and verify-citations-start.';
comment on column public.profiles.approval_note is
  'Optional internal note about the approval (or rejection). Surfaced only to the admin, never to the user.';
comment on column public.profiles.review_cap_override is
  'Per-user override for the contract-review monthly cap. Null = use the tier default from supabase-admin.js. Set per user from the /admin/users/ page.';
comment on column public.profiles.citation_cap_override is
  'Per-user override for the citation-verifier monthly cap. Null = use the tier default. Set per user from /admin/users/.';

-- Auto-approve every existing profile so this migration does not lock
-- out the admin or any current user. Only NEW signups starting now
-- need to be approved manually.
update public.profiles
  set approved_at = coalesce(approved_at, now())
  where approved_at is null;

-- Index so approval lookups are fast (every gated request reads it).
create index if not exists idx_profiles_approved_at
  on public.profiles (approved_at)
  where approved_at is not null;
