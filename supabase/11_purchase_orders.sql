-- ============================================================================
--  11_purchase_orders.sql  —  saved orders for /admin/stats ("Place an Order").
--  ADDITIVE and SAFE to run on a live database: it only creates a new table.
--
--  Why: orders built on the Place an Order page used to exist only as a
--  one-off PDF/Excel export. Each placed order is now stored as plain data
--  (supplier, date, and its lines as JSON), gets an order number, and the
--  page's "Previous orders" list rebuilds the PDF from that data on demand.
-- ============================================================================

create table if not exists public.purchase_orders (
  order_id      bigserial   primary key,
  order_no      text        generated always as ('PO-' || lpad(order_id::text, 4, '0')) stored,
  supplier_id   integer,
  supplier_name text,
  order_date    date        not null default current_date,
  created_by    text,
  -- [{ product_id, product_name, price, qty }, ...]
  items         jsonb       not null default '[]'::jsonb,
  total_amount  numeric     not null default 0,
  created_at    timestamptz not null default now()
);

create unique index if not exists purchase_orders_order_no_idx
  on public.purchase_orders (order_no);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- The page is admin-only, so reading and placing orders is too.
alter table public.purchase_orders enable row level security;
drop policy if exists p_po_read on public.purchase_orders;
drop policy if exists p_po_ins  on public.purchase_orders;
create policy p_po_read on public.purchase_orders for select using (public.app_role() = 'admin');
create policy p_po_ins  on public.purchase_orders for insert with check (public.app_role() = 'admin');

-- To undo:
--   drop table if exists public.purchase_orders;
