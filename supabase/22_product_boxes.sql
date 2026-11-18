-- ============================================================================
--  22_product_boxes.sql  —  saved boxes with their own piece counts.
--  ADDITIVE and SAFE to run on a live database.
--
--  A product can be packed in boxes that each hold a different number of
--  pieces (20, 30, 20, 40, 50 …). Printing box stickers on the Labels page
--  saves one row per box here; the sticker's barcode is "BX<box_id>".
--  At the POS, scanning that sticker (or picking the box) sells the whole box
--  as `pcs` pieces and marks it sold, so the same box can't be sold twice.
--
--  The pieces stay counted in the normal piece stock (stock_by_location);
--  a box is just a sealed group of them. Old "BX:<SKU>:<pcs>" stickers keep
--  working at the POS as before (no box row behind them).
-- ============================================================================

create table if not exists public.product_boxes (
  box_id       bigserial   primary key,
  product_id   integer     not null references public.products(product_id),
  location_id  integer,
  pcs          integer     not null check (pcs > 0),
  status       text        not null default 'sealed'
               check (status in ('sealed', 'sold', 'void')),
  created_at   timestamptz not null default now(),
  sold_at      timestamptz
);
create index if not exists product_boxes_sealed_idx on public.product_boxes (product_id) where status = 'sealed';

alter table public.product_boxes enable row level security;
drop policy if exists p_product_boxes_read on public.product_boxes;
drop policy if exists p_product_boxes_ins  on public.product_boxes;
-- POS (admin + staff) needs to see boxes; only admins make them (Labels page).
create policy p_product_boxes_read on public.product_boxes for select
  using (public.app_role() in ('admin', 'staff'));
create policy p_product_boxes_ins  on public.product_boxes for insert
  with check (public.app_role() = 'admin' and status = 'sealed');
-- No update/delete policy: status only changes through the functions below.

-- POS: after a sale goes through, mark its boxes sold. Only sealed boxes
-- change; returns how many did (fewer than asked = some were already sold).
create or replace function public.sell_boxes(p_box_ids bigint[])
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(public.app_role(), '') not in ('admin', 'staff') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update product_boxes set status = 'sold', sold_at = now()
   where box_id = any(p_box_ids) and status = 'sealed';
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.sell_boxes(bigint[]) to authenticated;

-- Labels page: remove a box that was made by mistake (admin only).
create or replace function public.void_box(p_box_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.app_role(), '') <> 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update product_boxes set status = 'void' where box_id = p_box_id and status = 'sealed';
end $$;
grant execute on function public.void_box(bigint) to authenticated;

-- To undo:
--   drop function if exists public.void_box(bigint);
--   drop function if exists public.sell_boxes(bigint[]);
--   drop table if exists public.product_boxes;
