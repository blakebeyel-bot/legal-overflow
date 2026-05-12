-- ============================================================================
-- 0041 — Microsoft Graph OAuth (Phase 2 of Paralegal voice agent)
--
-- Extends the existing workspace_user_api_keys table to hold per-user
-- Microsoft 365 OAuth credentials (encrypted refresh token + account email
-- for display). The Paralegal agent reads from Outlook mail + Calendar
-- + OneDrive via Microsoft Graph; tokens are stored here, encrypted with
-- the same AES-256-GCM key the rest of BYOK uses.
--
-- 1. Add 'microsoft' to the BYOK provider CHECK constraint.
-- 2. Add an optional `account_email` column so the /account/ page can
--    show "Connected · jane@firm.com".
--
-- The ciphertext column already stores the encrypted refresh token —
-- no new column needed for the token itself. fingerprint becomes the
-- last-4 chars of the connected account email (e.g. "@.com" gets stripped
-- by the app code so the badge reads "Yours · …firm" or similar).
-- ============================================================================

alter table public.workspace_user_api_keys
  drop constraint if exists workspace_user_api_keys_provider_check;

alter table public.workspace_user_api_keys
  add constraint workspace_user_api_keys_provider_check
  check (provider in ('anthropic','openai','google','xai','voyage','microsoft'));

-- Add the optional account_email column. NULL for non-Microsoft rows.
alter table public.workspace_user_api_keys
  add column if not exists account_email text;

-- Index by user+provider for fast OAuth-related lookups
-- (workspace_user_api_keys already has user_id as part of its key pattern;
--  this is just defensive — re-create only if missing).
create index if not exists idx_workspace_user_api_keys_user_provider
  on public.workspace_user_api_keys(user_id, provider);
