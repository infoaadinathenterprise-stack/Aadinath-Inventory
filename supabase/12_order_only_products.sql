-- ============================================================================
--  12_order_only_products.sql  —  remember the supplier of products added on
--  the Place an Order page (/admin/stats).
--  ADDITIVE and SAFE to run on a live database: one nullable column.
--
--  Why: a product typed in on Place an Order (type 'New Product', no SKU,
--  no stock) exists only for ordering — the inventory pages hide it (see
--  lib/orderOnly.ts). Recording the supplier it was added/ordered for keeps
--  it listed under that supplier next time, with the last ordered price.
-- ============================================================================

alter table public.products add column if not exists order_supplier_id integer;

-- To undo:
--   alter table public.products drop column if exists order_supplier_id;
