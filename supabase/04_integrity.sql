-- ============================================================================
--  04_integrity.sql  —  supports the #12 (purchase location) and #13 (SKU)
--  fixes. Additive and safe to run on a live database.
-- ============================================================================

-- #12: make sure purchase_items can record WHICH location each purchased item
-- stocked into, so deleting a purchase reverses the correct location instead
-- of guessing. No-op if the column already exists. (Until this runs, the app
-- still works — it just can't record the location, so deletes fall back to
-- the old guessing behavior for those rows.)
alter table public.purchase_items add column if not exists location_id integer;

-- #13 (OPTIONAL): stop duplicate SKUs at the database level. The app now
-- generates collision-free SKUs from the real product id, so this is just a
-- belt-and-suspenders guard. It will ERROR if you already have duplicate
-- SKUs, so find them first:
--
--   select lower(stock_keeping_unit) as sku, count(*)
--     from public.products
--    where stock_keeping_unit is not null and stock_keeping_unit <> ''
--    group by 1 having count(*) > 1;
--
-- Fix any duplicates, then uncomment and run:
--
-- create unique index if not exists products_sku_unique
--   on public.products (lower(stock_keeping_unit))
--   where stock_keeping_unit is not null and stock_keeping_unit <> '';
