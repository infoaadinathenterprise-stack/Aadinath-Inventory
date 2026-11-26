-- ============================================================================
--  24_order_drafts_delete.sql  —  let admins delete old order drafts.
--  ADDITIVE and SAFE to run on a live database: it only adds a policy.
--
--  Why: the Drafts list on /admin/stats ("Place an Order") has a Delete
--  button per draft. Without this policy RLS silently deletes nothing.
-- ============================================================================

drop policy if exists p_od_del on public.order_drafts;
create policy p_od_del on public.order_drafts for delete using (public.app_role() = 'admin');

-- To undo:
--   drop policy if exists p_od_del on public.order_drafts;
