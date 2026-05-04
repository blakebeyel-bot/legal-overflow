-- Round 8 — direct CourtListener URLs on tracker cases.
--
-- Why: the tracker page used to link to a CourtListener search keyed
-- on case_name + docket. That works but isn't ideal — sometimes the
-- top search result is the wrong opinion, and the user has to click
-- through an extra page. Storing the resolved opinion URL directly on
-- each case row gives the user a one-click path to the actual document.
--
-- Populated by tools/tracker/backfill-cl-urls.mjs, which runs the
-- CourtListener API search once per case and writes the top hit's
-- absolute_url here. The column is nullable — cases CourtListener
-- couldn't resolve (older state-court opinions, sealed matters, etc.)
-- simply don't get a link rendered.
--
-- Also exposes the column on v_tracker_cases so the front-end picks
-- it up via the existing query path.

alter table public.cases
  add column if not exists courtlistener_url text;

comment on column public.cases.courtlistener_url is
  'Direct URL to the opinion on CourtListener. Populated by the tracker backfill script. Nullable — null when CL has no matching opinion or the lookup failed.';

-- Re-create the v_tracker_cases view to expose the new column.
--
-- IMPORTANT: Postgres `create or replace view` will NOT change column
-- names or positions. Inserting `courtlistener_url` mid-list would shift
-- every subsequent column and trip a "cannot change name of view column"
-- error. Append it at the END instead — that's a backwards-compatible
-- column add as far as Postgres is concerned.
create or replace view public.v_tracker_cases as
select
  c.id              as case_id,
  c.slug,
  c.case_name,
  c.court,
  c.state,
  c.decision_date,
  c.docket_number,
  c.judge,
  c.party_type,
  c.ai_tool,
  c.status          as case_status,
  a.id              as annotation_id,
  a.severity,
  a.one_line,
  a.what_happened,
  a.what_went_wrong,
  a.outcome_summary,
  a.monetary_penalty_usd,
  a.professional_sanction,
  a.rule_1_1_competence,
  a.rule_3_3_candor,
  a.rule_1_6_confidentiality,
  a.rule_5_1_supervisory,
  a.rule_5_3_nonlawyer,
  a.insurance_exposure,
  a.bar_referral_risk,
  a.firm_policy_takeaway,
  a.prevention_notes,
  a.is_provisional,
  a.reviewed_by,
  a.reviewed_at,
  c.courtlistener_url
from public.cases c
left join public.annotations a
  on a.case_id = c.id
 and a.status = 'published'
where c.is_us = true
order by c.decision_date desc;
