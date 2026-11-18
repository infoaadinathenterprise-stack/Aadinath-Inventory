-- ============================================================================
--  19_hide_cost_from_public.sql  —  logged-out visitors can't read our cost.
--  SAFE to run on a live database; affects only the anon (logged-out) role.
--
--  Why: products are readable by everyone (p_products_read uses (true)) and
--  the anon key ships in the website, so anyone could ask the API for
--  buying_price. The storefront now asks only for public columns
--  (lib/publicProduct.ts); this makes the database refuse the rest too.
--
--  Logged-in users (admin and staff) use the 'authenticated' role and are
--  NOT affected.
--
--  NOTE: a column added to products later is NOT readable by logged-out
--  visitors until it is added to the grant below (and to
--  PUBLIC_PRODUCT_COLUMNS in lib/publicProduct.ts) — which is the safe default.
-- ============================================================================

revoke select on public.products from anon;
grant select (
  product_id, product_name, type, brand, model, stock_keeping_unit,
  unit_type, unit_of_measure, display_unit, pieces_per_box,
  box_selling_price, active_status, selling_price, image_url
) on public.products to anon;

-- Check (as anon this should now fail with "permission denied"):
--   set role anon; select buying_price from public.products limit 1; reset role;
--
-- To undo:
--   grant select on public.products to anon;
