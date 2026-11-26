-- ============================================================================
--  23_order_drafts.sql  —  saved drafts for /admin/stats ("Place an Order").
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--
--  Why: "Save draft" stores the order being built (checked products, typed
--  prices / quantities / units / supplier names, chosen supplier, low-stock
--  toggle) so "Open last draft" can bring it back later, on any device.
--  Every save is a new row; the page opens the newest.
-- ============================================================================

create table if not exists public.order_drafts (
  draft_id    bigserial   primary key,
  created_by  text,
  -- { selected: [product_id], orderInputs: {product_id: {price, qty, supName?, unit?}},
  --   supplierId, lowOnly, addedIds: [product_id] }
  data        jsonb       not null,
  created_at  timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The page is admin-only, so drafts are too.
alter table public.order_drafts enable row level security;
drop policy if exists p_od_read on public.order_drafts;
drop policy if exists p_od_ins  on public.order_drafts;
create policy p_od_read on public.order_drafts for select using (public.app_role() = 'admin');
create policy p_od_ins  on public.order_drafts for insert with check (public.app_role() = 'admin');

-- To undo:
--   drop table if exists public.order_drafts;
