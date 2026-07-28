-- ============================================================================
--  08_component_prices.sql  —  per-choice pricing for product components.
--  Additive + SAFE on a live database. Run in Supabase (SQL editor) BEFORE
--  deploying the matching app code (the client falls back gracefully if this
--  hasn't run yet, but the feature only works once the column exists).
-- ============================================================================

-- Some products are sold "with engine" / "with motor" and the SELLING PRICE
-- depends on which alternative the customer picks. Choice-group components
-- (rows sharing a `choice_group`) already model the either/or options; this
-- adds the price to charge when THAT option is the one chosen. The POS reads
-- it to pre-fill the sale price, and writes the price typed at checkout back
-- here so it's remembered next time. NULL = no per-choice price (falls back
-- to the product's normal selling price).
alter table public.product_components add column if not exists price numeric;

-- To undo:
--   alter table public.product_components drop column if exists price;
