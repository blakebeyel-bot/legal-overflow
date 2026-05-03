-- Round 7 — streamed findings for live UI preview.
--
-- Why: a contract review takes 5-7 minutes wall-clock. While that's a
-- defensible time for a partner-grade review, the user staring at a
-- spinner has no signal that anything is happening. Each specialist
-- finishes 30-90 s apart and produces immediately-readable findings;
-- showing them as they arrive cuts perceived wait time by 60-70%
-- without changing actual runtime.
--
-- How: each specialist appends its findings to reviews.streamed_findings
-- as soon as it completes. The client polls get-review every 2-3 s and
-- renders new findings into the progress panel. When the full review
-- completes, the streamed list is replaced by the compiler-reconciled
-- final list (which may have dropped duplicates / posture-rejected items).
--
-- Streamed findings are intentionally PRE-COMPILER and PRE-COHERENCE,
-- so the UI labels them as "preview." This is honest — they may include
-- items that get pruned. Better to show them than not.

alter table public.reviews
  add column if not exists streamed_findings jsonb default '[]'::jsonb;

comment on column public.reviews.streamed_findings is
  'Live findings appended by specialists during the analyze stage. PRE-compiler; may include items the compiler later dedupes or rejects. Cleared/replaced when the final findings_json is generated.';

-- Atomic append RPC — specialists run in parallel and may race on the
-- same row. Doing read-modify-write from JS would lose writes; this
-- function does the append in a single statement so concurrent calls
-- serialize on the row lock.
create or replace function public.append_streamed_findings(
  p_review_id uuid,
  p_findings jsonb
)
returns void
language sql
security definer
as $$
  update public.reviews
  set streamed_findings = coalesce(streamed_findings, '[]'::jsonb) || coalesce(p_findings, '[]'::jsonb)
  where id = p_review_id;
$$;

comment on function public.append_streamed_findings is
  'Atomic append for reviews.streamed_findings. Used by fanout-background after each specialist completes.';
