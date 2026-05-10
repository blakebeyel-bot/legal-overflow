-- 0031_profiles_display_name.sql
--
-- Adds a per-user display_name on profiles. This is the user's
-- "author" identity for any document markup the platform produces on
-- their behalf — tracked changes in finalized redlines, comments in
-- corrected briefs, sticky notes on annotated PDFs, comments embedded
-- by the citation verifier, etc.
--
-- Universal override: every output that today hardcodes
-- author='Legal Overflow' will read profiles.display_name first.
-- When it's null/empty (new accounts), the fallback stays 'Legal
-- Overflow' so we never produce a markup with an awkward "anonymous"
-- author.
--
-- The 0028 RLS lockdown (profiles_self_update) pinned tier /
-- approved_at / cap_overrides via WITH CHECK. display_name is NOT in
-- that list, so users CAN update their own display_name from the
-- browser via supabase-js — same path the /account/ settings page
-- uses to save it. (Tier / approval columns stay locked, only the
-- display name is freely user-editable.)
--
-- Safe to re-run.

alter table public.profiles
  add column if not exists display_name text;

-- Reasonable cap so the column doesn't get used for arbitrary blob
-- storage. 80 chars covers any real name + initials + suffix.
alter table public.profiles
  drop constraint if exists profiles_display_name_length;
alter table public.profiles
  add constraint profiles_display_name_length
  check (display_name is null or char_length(display_name) <= 80);

comment on column public.profiles.display_name is
  '(0031) The user-chosen author name attributed on every document the platform marks up on their behalf — tracked changes, sticky-note comments, redline insertions, etc. Editable by the user via /account/. Fallback when null = ''Legal Overflow''. Universal across every output (compare-finalize, contract-review, citation-verifier, redline, tr-finalize-doc).';
