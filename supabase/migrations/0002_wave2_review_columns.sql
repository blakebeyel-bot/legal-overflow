-- =====================================================================
-- Wave 2 — add deal posture, governing-agreement context, profile snapshot,
-- and classifier confidence to the reviews row.
-- Paste into Supabase SQL Editor and run.
-- =====================================================================

alter table public.reviews
  add column if not exists deal_posture text
    check (deal_posture in (
      'our_paper',
      'their_paper_high_leverage',
      'their_paper_low_leverage',
      'negotiated_draft'
    )),
  add column if not exists governing_agreement_context jsonb,
  add column if not exists profile_snapshot jsonb,
  add column if not exists classification_confidence numeric(3,2)
    check (classification_confidence is null or
           (classification_confidence >= 0 and classification_confidence <= 1)),
  add column if not exists pipeline_mode_confirmed_at timestamptz;

-- Backfill existing rows are fine with NULLs — the code treats missing
-- deal_posture as 'unknown' and falls back to the original behavior.

-- Verify
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'reviews'
  and column_name in (
    'deal_posture', 'governing_agreement_context', 'profile_snapshot',
    'classification_confidence', 'pipeline_mode_confirmed_at'
  );
