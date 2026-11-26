-- ============================================================================
--  25_supplier_products.sql  —  products linked to a supplier by hand.
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--
--  Why: on Place an Order (/admin/stats) a supplier's list comes from what was
--  bought from / ordered from them. A product never bought from them (e.g. one
--  just added) can be found by search and linked with "Add to <supplier>";
--  that link is stored here so the product shows under the supplier from then on.
-- ============================================================================

create table if not exists public.supplier_products (
  supplier_id  integer     not null,
  product_id   integer     not null,
  created_by   text,
  created_at   timestamptz not null default now(),
  primary key (supplier_id, product_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Place an Order is admin-only, so this is too.
alter table public.supplier_products enable row level security;
drop policy if exists p_sp_read on public.supplier_products;
drop policy if exists p_sp_ins  on public.supplier_products;
create policy p_sp_read on public.supplier_products for select using (public.app_role() = 'admin');
create policy p_sp_ins  on public.supplier_products for insert with check (public.app_role() = 'admin');

-- To undo:
--   drop table if exists public.supplier_products;
