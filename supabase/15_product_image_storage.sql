-- ============================================================================
--  15_product_image_storage.sql  —  keep product photos in Storage, not rows.
--  ADDITIVE and SAFE to run on a live database.
--
--  Why: uploaded photos were saved inside products.image_url as base64 data
--  URLs (~31 KB each, 7.7 MB for 251 photos). Every page that lists products
--  downloads the whole products table — and again after every stock change —
--  so each load pulled megabytes of pictures and pages took a minute to
--  appear. Photos now live in a public Storage bucket and image_url holds a
--  short link; the browser fetches (and caches) only the pictures on screen.
--
--  1. Backs up every inline photo first (product_image_backup), so the move
--     can't lose one. Restore with:
--       update public.products p set image_url = b.image_url
--         from public.product_image_backup b where b.product_id = p.product_id;
--  2. Creates the public "product-images" bucket; only admins can upload.
-- ============================================================================

-- 1. Backup of the inline photos (not read by the app; dashboard only).
create table if not exists public.product_image_backup (
  product_id   integer     primary key,
  image_url    text        not null,
  backed_up_at timestamptz not null default now()
);
insert into public.product_image_backup (product_id, image_url)
  select product_id, image_url from public.products
   where image_url like 'data:image/%' and image_url not like 'data:image/svg%'
on conflict (product_id) do nothing;
alter table public.product_image_backup enable row level security;  -- no policies: hidden from the app

-- 2. Public bucket for product photos (2 MB max, images only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists p_product_images_ins on storage.objects;
drop policy if exists p_product_images_upd on storage.objects;
drop policy if exists p_product_images_del on storage.objects;
create policy p_product_images_ins on storage.objects for insert
  with check (bucket_id = 'product-images' and auth.jwt() ->> 'app_role' = 'admin');
create policy p_product_images_upd on storage.objects for update
  using (bucket_id = 'product-images' and auth.jwt() ->> 'app_role' = 'admin');
create policy p_product_images_del on storage.objects for delete
  using (bucket_id = 'product-images' and auth.jwt() ->> 'app_role' = 'admin');
