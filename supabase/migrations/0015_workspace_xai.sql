-- Round 15 — add xAI / Grok as a fourth LLM provider.
--
-- Mirrors the existing anthropic / openai / google provider treatment.
-- xAI's API is OpenAI-compatible so the only schema change is widening
-- the BYOK provider enum.

alter table public.workspace_user_api_keys
  drop constraint if exists workspace_user_api_keys_provider_check;

alter table public.workspace_user_api_keys
  add constraint workspace_user_api_keys_provider_check
  check (provider in ('anthropic','openai','google','xai'));
