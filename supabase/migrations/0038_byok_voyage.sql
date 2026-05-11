-- Add Voyage to the BYOK provider whitelist.
--
-- Voyage AI is offered as a user-selectable embedding provider on
-- the Vault settings page (alongside Gemini + OpenAI), but until
-- now there was no BYOK row on the account page for users to
-- supply their own Voyage key. This migration adds 'voyage' to the
-- CHECK constraint on workspace_user_api_keys.provider so the
-- account-page Save endpoint can persist Voyage keys per user.
--
-- Same pattern as migration 0015_workspace_xai.sql.

alter table public.workspace_user_api_keys
  drop constraint if exists workspace_user_api_keys_provider_check;

alter table public.workspace_user_api_keys
  add constraint workspace_user_api_keys_provider_check
  check (provider in ('anthropic','openai','google','xai','voyage'));
