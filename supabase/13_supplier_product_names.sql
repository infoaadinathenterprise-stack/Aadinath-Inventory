-- ============================================================================
--  13_supplier_product_names.sql  —  what each supplier calls our products.
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--
--  Why: suppliers name items differently from our catalogue. Place an Order
--  (/admin/stats) lets you enter the supplier's name for a product; it's
--  remembered per (supplier, product), filled in next time that supplier is
--  picked, and is what the order PDF / Excel show as the product name.
-- ============================================================================

create table if not exists public.supplier_product_names (
  supplier_id           integer     not null,
  product_id            integer     not null,
  supplier_product_name text        not null,
  updated_at            timestamptz not null default now(),
  primary key (supplier_id, product_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Place an Order is admin-only, so this is too.
alter table public.supplier_product_names enable row level security;
drop policy if exists p_spn_read on public.supplier_product_names;
drop policy if exists p_spn_ins  on public.supplier_product_names;
drop policy if exists p_spn_upd  on public.supplier_product_names;
drop policy if exists p_spn_del  on public.supplier_product_names;
create policy p_spn_read on public.supplier_product_names for select using (public.app_role() = 'admin');
create policy p_spn_ins  on public.supplier_product_names for insert with check (public.app_role() = 'admin');
create policy p_spn_upd  on public.supplier_product_names for update using (public.app_role() = 'admin') with check (public.app_role() = 'admin');
create policy p_spn_del  on public.supplier_product_names for delete using (public.app_role() = 'admin');

-- To undo:
--   drop table if exists public.supplier_product_names;
