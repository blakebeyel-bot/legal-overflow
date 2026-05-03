-- Round 6 — party detection at classification time.
--
-- The intake form used to ask the user to type in their "typical role in
-- contracts" (Vendor, Supplier, Subcontractor, ...). Specialists then
-- drafted clauses using whatever the user typed, even when the contract's
-- own Defined Term for that party was different (contract said "Supplier",
-- form said "Subcontractor", drafted clauses universally said "Subcontractor").
--
-- New flow:
--   1. After classification, a fast LLM pre-pass reads the first page or
--      two of the extracted contract text and identifies the parties along
--      with the Defined Term each party is given (e.g. "Acme Corp ('Buyer')"
--      and "Crane Industries ('Supplier')"). The list is saved to
--      reviews.detected_parties.
--   2. The intake confirm panel shows the parties to the user and asks them
--      to pick which one they are representing. The selection is saved to
--      reviews.client_party.
--   3. fanout-background passes review.client_party.defined_term to every
--      specialist as CLIENT_DEFINED_TERM, which prompts use when drafting
--      proposed_text and external_comment.
--
-- Both columns nullable so legacy reviews and clients that don't supply the
-- field still work end-to-end.

alter table public.reviews
  add column if not exists detected_parties jsonb,
  add column if not exists client_party jsonb;

comment on column public.reviews.detected_parties is
  'Array of {name, defined_term, role_hint?} from the party-detection pre-pass. Source of truth for the intake party picker.';
comment on column public.reviews.client_party is
  '{name, defined_term} chosen by the user during intake. defined_term is used by specialists when drafting proposed_text and external_comment.';
