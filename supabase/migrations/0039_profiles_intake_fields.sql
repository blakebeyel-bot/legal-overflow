-- ============================================================================
-- 0039 — profiles intake fields (full_name + organization)
--
-- The signup form historically collected only email + password, which left
-- the admin approval queue blind: when a row appears in profiles with
-- approved_at = NULL, the only context for the human approver is the
-- email address.
--
-- This migration:
--   1. Adds full_name + organization columns to public.profiles.
--   2. Updates the handle_new_user() trigger to copy those values out of
--      auth.users.raw_user_meta_data — which is where supabase.auth.signUp's
--      `options.data: {...}` payload ends up.
--
-- RLS posture: migration 0028's WITH CHECK clause on profiles_self_update
-- already pins the approval columns to their existing values. The two new
-- columns are NOT in that pinned list, so users can update their own
-- full_name / organization (intended — they can edit it on /account/).
-- ============================================================================

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists organization text;

-- Replace the trigger function so signup-supplied metadata is captured
-- on the very first row creation. Existing rows are untouched.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, organization)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'organization'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger itself doesn't need to be re-created (it still references the
-- same function name), but we re-declare for idempotency in case this
-- migration is applied on a fresh db without 0001.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
