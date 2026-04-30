-- =====================================================================
-- Legal Overflow — Citation Verifier storage buckets
-- =====================================================================
-- Run this AFTER 0005_citation_verifier.sql.
--
-- Creates two private storage buckets:
--   • citation-verifier-incoming — uploaded source files (deleted after run)
--   • citation-verifier-output   — form report + marked source + JSON
--
-- Both buckets have RLS so a user can only read objects they own. The
-- service-role key (used by the pipeline function) bypasses RLS.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- buckets ----------
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('citation-verifier-incoming', 'citation-verifier-incoming', false, 52428800),  -- 50 MB
  ('citation-verifier-output',   'citation-verifier-output',   false, 52428800)   -- 50 MB
on conflict (id) do nothing;

-- ---------- RLS for INCOMING (uploads) ----------
-- Users can upload to their own folder; service-role bypasses RLS for
-- pipeline cleanup.
drop policy if exists "users upload own incoming" on storage.objects;
create policy "users upload own incoming"
  on storage.objects for insert
  with check (
    bucket_id = 'citation-verifier-incoming'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users read own incoming" on storage.objects;
create policy "users read own incoming"
  on storage.objects for select
  using (
    bucket_id = 'citation-verifier-incoming'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete own incoming" on storage.objects;
create policy "users delete own incoming"
  on storage.objects for delete
  using (
    bucket_id = 'citation-verifier-incoming'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------- RLS for OUTPUT (reports + marked source) ----------
drop policy if exists "users read own output" on storage.objects;
create policy "users read own output"
  on storage.objects for select
  using (
    bucket_id = 'citation-verifier-output'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Inserts into citation-verifier-output go through the service role
-- only — the pipeline writes outputs server-side, never the browser.

-- =====================================================================
-- Verify with:
--   select id, name, public, file_size_limit
--   from storage.buckets
--   where id like 'citation-verifier-%';
-- =====================================================================
