-- System templates support — pre-built templates seeded with
-- user_id = NULL. Migration 0035 added the source_kind='template'
-- bucket but kept the existing NOT NULL constraint on user_id from
-- migration 0026. This migration relaxes that so the seed function
-- (and any future system-owned vault items) can insert NULL.
--
-- All user-facing endpoints already filter by user_id explicitly
-- (either eq. or .is.null branch), so nullable user_id is safe.
-- The auth.users FK with ON DELETE CASCADE continues to function:
-- NULL doesn't violate the reference.

alter table public.workspace_vault_items
  alter column user_id drop not null;

-- Extend the RLS read policy so authenticated users can SELECT
-- system-owned templates directly. (Service-role reads via the
-- workspace-vault-list endpoint already bypass RLS, but a direct
-- supabase.from('workspace_vault_items') call from the browser
-- would currently filter system templates out.)
drop policy if exists vault_items_system_templates_read on public.workspace_vault_items;
create policy vault_items_system_templates_read
  on public.workspace_vault_items for select
  using (
    user_id is null and source_kind = 'template'
  );

-- Same for chunks owned by system-template items, so the search RPC
-- can rank system templates against user queries when needed.
drop policy if exists vault_chunks_system_templates_read on public.workspace_vault_chunks;
create policy vault_chunks_system_templates_read
  on public.workspace_vault_chunks for select
  using (
    exists (
      select 1 from public.workspace_vault_items i
      where i.id = workspace_vault_chunks.item_id
        and i.user_id is null
    )
  );
