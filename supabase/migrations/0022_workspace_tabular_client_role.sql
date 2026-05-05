-- Round 22 — client role + free-form context on tabular reviews.
--
-- The same contract reads completely differently depending on whose
-- side you're on. A liability cap is good for the seller and bad
-- for the buyer; auto-renewal is good for the landlord and bad for
-- the tenant. Adding a client_role lets the prompt builder steer
-- the LLM toward the user's perspective for overviews, red flags,
-- and redline proposals.
--
-- additional_context is a free-text notes field — anything else the
-- user wants the AI to keep in mind ("the seller has been promising
-- a 30-day delivery window verbally", "we've already signed an LOI
-- at $1.2M", etc.).

alter table public.workspace_tabular_reviews
  add column if not exists client_role text,
  add column if not exists additional_context text;
