-- =====================================================================
-- Round 6 — extend citation_existence_status with name/location mismatches
-- =====================================================================
-- The Round 6 CourtListener layer introduced a four-state classifier:
--   • existence_verified
--   • existence_name_mismatch    ← NEW (cite resolves to a different case)
--   • existence_location_mismatch ← NEW (case at a different cite)
--   • existence_not_found / existence_uncertain / not_applicable (existing)
--
-- Adding the two new values lets the citations table store the full
-- four-state classification instead of folding name_mismatch /
-- location_mismatch down to "uncertain" via the orchestrator's defensive
-- mapper.
--
-- Idempotent — safe to re-run. Each ADD VALUE is conditional via the
-- DO block; Postgres errors on adding an already-existing enum label.
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'citation_existence_status'
      and e.enumlabel = 'existence_name_mismatch'
  ) then
    alter type public.citation_existence_status add value 'existence_name_mismatch';
  end if;

  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'citation_existence_status'
      and e.enumlabel = 'existence_location_mismatch'
  ) then
    alter type public.citation_existence_status add value 'existence_location_mismatch';
  end if;
end$$;

-- =====================================================================
-- After running, verify with:
--   select unnest(enum_range(null::public.citation_existence_status));
-- Expected result: 6 rows
--   existence_verified
--   existence_not_found
--   existence_uncertain
--   not_applicable
--   existence_name_mismatch    ← new
--   existence_location_mismatch ← new
-- =====================================================================
