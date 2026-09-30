-- ============================================================================
--  14_edit_purchase_orders.sql  —  let placed orders be edited.
--  ADDITIVE and SAFE to run on a live database: one column + one policy.
--
--  Why: Previous Orders (/admin/stats) can now open an order, change its
--  lines (supplier's product names, prices, quantities, units, remove a
--  line) or supplier, save it, and regenerate the PDF / Excel from the
--  updated data. The order number stays the same.
-- ============================================================================

alter table public.purchase_orders add column if not exists updated_at timestamptz;

drop policy if exists p_po_upd on public.purchase_orders;
create policy p_po_upd on public.purchase_orders for update
  using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

-- To undo:
--   drop policy if exists p_po_upd on public.purchase_orders;
--   alter table public.purchase_orders drop column if exists updated_at;
