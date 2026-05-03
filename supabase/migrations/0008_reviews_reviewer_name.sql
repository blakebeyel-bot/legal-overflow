-- Round 5+ — customizable reviewer attribution
--
-- HISTORICAL NOTE: this column was added during a per-review attribution
-- design, then superseded by storing the reviewer name on the company
-- profile (profile.output.reviewer_author) so it carries across all
-- reviews for that user. The column is currently unused — kept for now
-- because dropping it would require a follow-up migration and the dead
-- column is harmless. Safe to drop in a future cleanup migration.
alter table public.reviews
  add column if not exists reviewer_name text;

comment on column public.reviews.reviewer_name is
  'UNUSED — attribution now lives on profile.output.reviewer_author. Safe to drop.';
