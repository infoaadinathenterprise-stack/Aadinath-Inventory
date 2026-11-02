-- ============================================================================
--  16_purchase_delivery.sql  —  delivery charges (with receipt) per purchase.
--  ADDITIVE and SAFE to run on a live database: two nullable columns and a
--  new private Storage bucket.
--
--  Why: the Purchases page lets you record what delivery cost for each bill
--  and attach a photo of the delivery receipt. Receipts are business
--  documents, so their bucket is PRIVATE: only admins can view (via short-
--  lived signed links) or upload them.
-- ============================================================================

alter table public.purchases add column if not exists delivery_charge       numeric;
alter table public.purchases add column if not exists delivery_receipt_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-receipts', 'delivery-receipts', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists p_delivery_receipts_sel on storage.objects;
drop policy if exists p_delivery_receipts_ins on storage.objects;
drop policy if exists p_delivery_receipts_upd on storage.objects;
drop policy if exists p_delivery_receipts_del on storage.objects;
create policy p_delivery_receipts_sel on storage.objects for select
  using (bucket_id = 'delivery-receipts' and auth.jwt() ->> 'app_role' = 'admin');
create policy p_delivery_receipts_ins on storage.objects for insert
  with check (bucket_id = 'delivery-receipts' and auth.jwt() ->> 'app_role' = 'admin');
create policy p_delivery_receipts_upd on storage.objects for update
  using (bucket_id = 'delivery-receipts' and auth.jwt() ->> 'app_role' = 'admin');
create policy p_delivery_receipts_del on storage.objects for delete
  using (bucket_id = 'delivery-receipts' and auth.jwt() ->> 'app_role' = 'admin');

-- To undo:
--   alter table public.purchases drop column if exists delivery_receipt_path;
--   alter table public.purchases drop column if exists delivery_charge;
