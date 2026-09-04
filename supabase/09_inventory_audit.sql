-- ============================================================================
--  09_inventory_audit.sql  —  persisted checklist state for /admin/inventory-audit.
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--  Nothing else changes until the new audit-page code deploys.
--
--  Why: the audit page lets a user tick off each product as "physically
--  counted, matches the system". Without persistence, closing the tab or
--  refreshing lost all progress and forced starting the whole count over.
--  This table remembers, per (location, product), that it's been checked
--  (and whether the count was corrected) until an explicit "start new
--  audit" reset clears it for that location.
-- ============================================================================

create table if not exists public.inventory_audit_checks (
  id          bigserial primary key,
  location_id integer     not null,
  product_id  integer     not null,
  checked_at  timestamptz not null default now(),
  checked_by  text,
  edited      boolean     not null default false,
  unique (location_id, product_id)
);

create index if not exists inventory_audit_checks_loc_idx
  on public.inventory_audit_checks (location_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Same access shape as stock_by_location: any logged-in user (admin or
-- staff) can read and tick/untick rows; the audit page is open to both.
alter table public.inventory_audit_checks enable row level security;
drop policy if exists p_audit_read on public.inventory_audit_checks;
drop policy if exists p_audit_ins  on public.inventory_audit_checks;
drop policy if exists p_audit_upd  on public.inventory_audit_checks;
drop policy if exists p_audit_del  on public.inventory_audit_checks;
create policy p_audit_read on public.inventory_audit_checks for select using (public.app_role() in ('admin','staff'));
create policy p_audit_ins  on public.inventory_audit_checks for insert with check (public.app_role() in ('admin','staff'));
create policy p_audit_upd  on public.inventory_audit_checks for update using (public.app_role() in ('admin','staff')) with check (public.app_role() in ('admin','staff'));
create policy p_audit_del  on public.inventory_audit_checks for delete using (public.app_role() in ('admin','staff'));

-- To undo:
--   drop table if exists public.inventory_audit_checks;
