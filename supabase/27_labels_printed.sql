-- ============================================================================
--  27_labels_printed.sql  —  "✓ Printed" marks on the Labels page, shared.
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--
--  Why: the marks lived in each browser's localStorage, so a label printed
--  from the phone never showed as printed on the PC. One row per product
--  printed in the current batch; "Clear" on the Labels page empties it.
-- ============================================================================

create table if not exists public.labels_printed (
  product_id  integer     primary key,
  printed_by  text,
  printed_at  timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The Labels page is admin-only (same as print_jobs / print_settings).
alter table public.labels_printed enable row level security;
drop policy if exists p_lp_read on public.labels_printed;
drop policy if exists p_lp_ins  on public.labels_printed;
drop policy if exists p_lp_upd  on public.labels_printed;
drop policy if exists p_lp_del  on public.labels_printed;
create policy p_lp_read on public.labels_printed for select using (public.app_role() = 'admin');
create policy p_lp_ins  on public.labels_printed for insert with check (public.app_role() = 'admin');
create policy p_lp_upd  on public.labels_printed for update using (public.app_role() = 'admin') with check (public.app_role() = 'admin');
create policy p_lp_del  on public.labels_printed for delete using (public.app_role() = 'admin');

-- To undo:
--   drop table if exists public.labels_printed;
