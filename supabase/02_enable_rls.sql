-- ============================================================================
--  02_enable_rls.sql   —  THE LOCKDOWN. Run this LAST.
--  Run only AFTER: (a) 01_security_setup.sql has been run, (b) the new code
--  is deployed, and (c) the Cloudflare secrets are set. After this runs,
--  the anonymous public key can no longer write anything, and admin-only
--  operations require a token whose signed role is 'admin'.
--
--  Roles recap:
--    anon           = not logged in (public storefront). Read-only catalog.
--    authenticated  = any logged-in user (staff OR admin).
--    app_role()     = 'admin' or 'staff', read from the signed login token.
--
--  If something breaks, you can fully revert with the block at the bottom.
-- ============================================================================

-- Convenience: shorthand for "the logged-in user is an admin".
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select public.app_role() = 'admin'
$$;

-- ── products ────────────────────────────────────────────────────────────────
-- Public storefront reads them. Only admins create/edit. No hard deletes
-- (the app soft-deletes via active_status = false).
alter table public.products enable row level security;
drop policy if exists p_products_read   on public.products;
drop policy if exists p_products_write  on public.products;
drop policy if exists p_products_update on public.products;
create policy p_products_read   on public.products for select using (true);
create policy p_products_write  on public.products for insert with check (public.is_admin());
create policy p_products_update on public.products for update using (public.is_admin()) with check (public.is_admin());

-- ── locations ───────────────────────────────────────────────────────────────
alter table public.locations enable row level security;
drop policy if exists p_locations_read  on public.locations;
drop policy if exists p_locations_write on public.locations;
drop policy if exists p_locations_upd   on public.locations;
create policy p_locations_read  on public.locations for select using (true);
create policy p_locations_write on public.locations for insert with check (public.is_admin());
create policy p_locations_upd   on public.locations for update using (public.is_admin()) with check (public.is_admin());

-- ── stock_by_location ───────────────────────────────────────────────────────
-- Storefront reads stock. Any logged-in user may change stock (POS sales,
-- transfers). Only admins may delete stock rows (product/purchase cleanup).
alter table public.stock_by_location enable row level security;
drop policy if exists p_stock_read   on public.stock_by_location;
drop policy if exists p_stock_ins    on public.stock_by_location;
drop policy if exists p_stock_upd    on public.stock_by_location;
drop policy if exists p_stock_del    on public.stock_by_location;
create policy p_stock_read on public.stock_by_location for select using (true);
create policy p_stock_ins  on public.stock_by_location for insert with check (public.app_role() in ('admin','staff'));
create policy p_stock_upd  on public.stock_by_location for update using (public.app_role() in ('admin','staff')) with check (public.app_role() in ('admin','staff'));
create policy p_stock_del  on public.stock_by_location for delete using (public.is_admin());

-- ── product_components ──────────────────────────────────────────────────────
-- Read needed by POS/inventory (any logged-in user). Config is admin-only.
alter table public.product_components enable row level security;
drop policy if exists p_comp_read on public.product_components;
drop policy if exists p_comp_ins  on public.product_components;
drop policy if exists p_comp_del  on public.product_components;
create policy p_comp_read on public.product_components for select using (true);
create policy p_comp_ins  on public.product_components for insert with check (public.is_admin());
create policy p_comp_del  on public.product_components for delete using (public.is_admin());

-- ── stock_requests (movement log + pending stock-in requests) ───────────────
-- Any logged-in user inserts (movement logs, staff stock-in requests).
-- Only admins update (approve / reject).
alter table public.stock_requests enable row level security;
drop policy if exists p_req_read on public.stock_requests;
drop policy if exists p_req_ins  on public.stock_requests;
drop policy if exists p_req_upd  on public.stock_requests;
create policy p_req_read on public.stock_requests for select using (public.app_role() in ('admin','staff'));
create policy p_req_ins  on public.stock_requests for insert with check (public.app_role() in ('admin','staff'));
create policy p_req_upd  on public.stock_requests for update using (public.is_admin()) with check (public.is_admin());

-- ── sales ───────────────────────────────────────────────────────────────────
-- Any logged-in user records a sale (POS). Staff can read back only their
-- OWN sales (needed so the insert can return the new sale_id); admins read
-- all. Only admins may void (update). No deletes.
alter table public.sales enable row level security;
drop policy if exists p_sales_read on public.sales;
drop policy if exists p_sales_ins  on public.sales;
drop policy if exists p_sales_upd  on public.sales;
create policy p_sales_read on public.sales for select
  using (public.is_admin() or performed_by = (auth.jwt() ->> 'full_name'));
create policy p_sales_ins  on public.sales for insert with check (public.app_role() in ('admin','staff'));
create policy p_sales_upd  on public.sales for update using (public.is_admin()) with check (public.is_admin());

-- ── sale_items ──────────────────────────────────────────────────────────────
-- Insert by any logged-in user (POS). Read is admin-only (the Sales page is
-- an admin page). The POS insert does not read rows back, so this is safe.
alter table public.sale_items enable row level security;
drop policy if exists p_saleitems_read on public.sale_items;
drop policy if exists p_saleitems_ins  on public.sale_items;
create policy p_saleitems_read on public.sale_items for select using (public.is_admin());
create policy p_saleitems_ins  on public.sale_items for insert with check (public.app_role() in ('admin','staff'));

-- ── withdrawals (cash out of the till) ──────────────────────────────────────
-- Admin-only in every direction.
alter table public.withdrawals enable row level security;
drop policy if exists p_wd_all on public.withdrawals;
create policy p_wd_all on public.withdrawals for all
  using (public.is_admin()) with check (public.is_admin());

-- ── purchases / purchase_items / suppliers ──────────────────────────────────
-- Admin-only. The storefront never touches these.
alter table public.purchases enable row level security;
drop policy if exists p_purch_all on public.purchases;
create policy p_purch_all on public.purchases for all
  using (public.is_admin()) with check (public.is_admin());

alter table public.purchase_items enable row level security;
drop policy if exists p_purchitems_all on public.purchase_items;
create policy p_purchitems_all on public.purchase_items for all
  using (public.is_admin()) with check (public.is_admin());

alter table public.suppliers enable row level security;
drop policy if exists p_suppliers_all on public.suppliers;
create policy p_suppliers_all on public.suppliers for all
  using (public.is_admin()) with check (public.is_admin());

-- ── app_users (holds PIN hashes) ────────────────────────────────────────────
-- Sealed from browsers entirely. No policies = default deny for anon and
-- authenticated. Only the server functions (service_role) can touch it,
-- and they re-check the admin role themselves.
alter table public.app_users enable row level security;
drop policy if exists p_users_none on public.app_users;
-- (intentionally no permissive policy)

-- ============================================================================
--  EMERGENCY REVERT — if the app breaks after this, run this block to turn
--  RLS back off and restore the previous (open) behavior while you debug:
--
--    alter table public.products            disable row level security;
--    alter table public.locations           disable row level security;
--    alter table public.stock_by_location   disable row level security;
--    alter table public.product_components  disable row level security;
--    alter table public.stock_requests      disable row level security;
--    alter table public.sales               disable row level security;
--    alter table public.sale_items          disable row level security;
--    alter table public.withdrawals         disable row level security;
--    alter table public.purchases           disable row level security;
--    alter table public.purchase_items      disable row level security;
--    alter table public.suppliers           disable row level security;
--    alter table public.app_users           disable row level security;
-- ============================================================================
