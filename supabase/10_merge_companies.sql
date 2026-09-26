-- ════════════════════════════════════════════════════════════════════════════
--  10_merge_companies.sql  —  merge Aadinath (company 1) into Jay Aadinath (2).
--
--  • Backs up every row it changes into _bak_merge_* tables (API-inaccessible).
--  • Adds Aadinath's stock onto Jay Aadinath's for the same product+location,
--    then removes the Aadinath rows. Per product+location totals are checked
--    before/after and the whole script rolls back if anything differs.
--  • Re-tags purchases, sale lines and stock requests to company 2.
--  • Makes company 2 the default everywhere (column defaults + the stock
--    functions' fallback) and adds guards so any write that still says
--    company 1 (or none) lands on Jay Aadinath instead.
--  • Deletes the Aadinath company.
--
--  Runs in one transaction. Safe to re-run: a second run finds nothing to move.
--  Rollback notes are at the bottom.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- 0. Sanity: Jay Aadinath must exist.
do $$
begin
  if not exists (select 1 from public.companies where company_id = 2) then
    raise exception 'Company 2 (Jay Aadinath) not found — aborting';
  end if;
end $$;

-- 0b. These columns come from 06/07; make sure they exist so the rest of the
--     script is valid even if 07_fixes.sql was never run.
alter table public.sale_items     add column if not exists company_id integer;
alter table public.stock_requests add column if not exists company_id integer not null default 2;

-- 1. Backups of everything that will change.
create table if not exists public._bak_merge_stock_by_location as
  select * from public.stock_by_location where company_id in (1, 2);
create table if not exists public._bak_merge_purchases as
  select purchase_id, company_id from public.purchases where company_id = 1;
create table if not exists public._bak_merge_sale_items as
  select * from public.sale_items where company_id = 1 or company_id is null;
create table if not exists public._bak_merge_stock_requests as
  select request_id, company_id from public.stock_requests where company_id = 1;
create table if not exists public._bak_merge_companies as
  select * from public.companies where company_id = 1;
-- RLS on with no policies = not readable through the public API.
alter table public._bak_merge_stock_by_location enable row level security;
alter table public._bak_merge_purchases         enable row level security;
alter table public._bak_merge_sale_items        enable row level security;
alter table public._bak_merge_stock_requests    enable row level security;
alter table public._bak_merge_companies         enable row level security;

-- 2. Snapshot per product+location totals (all companies) for the check.
create temp table _merge_before on commit drop as
  select product_id, location_id, sum(quantity) as q, sum(box_quantity) as b
  from public.stock_by_location group by product_id, location_id;

-- 3. Merge stock. (a) add company-1 amounts onto existing company-2 rows,
--    (b) drop those company-1 rows, (c) re-tag the remaining company-1 rows.
update public.stock_by_location j
   set quantity     = j.quantity     + a.quantity,
       box_quantity = j.box_quantity + a.box_quantity,
       updated_at   = now()
  from public.stock_by_location a
 where a.company_id = 1 and j.company_id = 2
   and j.product_id = a.product_id and j.location_id = a.location_id;

delete from public.stock_by_location a
 where a.company_id = 1
   and exists (select 1 from public.stock_by_location j
                where j.company_id = 2 and j.product_id = a.product_id and j.location_id = a.location_id);

update public.stock_by_location set company_id = 2, updated_at = now() where company_id = 1;

-- 4. Verify nothing was lost or double-counted.
do $$
declare n int;
begin
  select count(*) into n
  from _merge_before b
  full outer join (
    select product_id, location_id, sum(quantity) as q, sum(box_quantity) as b
    from public.stock_by_location group by product_id, location_id
  ) a using (product_id, location_id)
  where coalesce(b.q, 0) <> coalesce(a.q, 0) or coalesce(b.b, 0) <> coalesce(a.b, 0);
  if n > 0 then
    raise exception 'Stock totals changed for % product/location pair(s) — rolled back', n;
  end if;
  if exists (select 1 from public.stock_by_location where company_id = 1) then
    raise exception 'Company 1 stock rows remain — rolled back';
  end if;
end $$;

-- 5. Re-tag history.
update public.purchases      set company_id = 2 where company_id = 1;
update public.sale_items     set company_id = 2 where company_id = 1 or company_id is null;
update public.stock_requests set company_id = 2 where company_id = 1;

-- 6. Defaults → Jay Aadinath.
alter table public.stock_by_location alter column company_id set default 2;
alter table public.purchases         alter column company_id set default 2;
alter table public.sale_items        alter column company_id set default 2;
alter table public.stock_requests    alter column company_id set default 2;

-- 7. Stock functions fall back to company 1 when none is given. Patch just
--    that fallback in the LIVE definitions (so nothing else in them changes).
do $$
declare
  fn  text;
  d   text;
  d2  text;
  pats text[][] := array[
    array['public.stock_txn(jsonb,jsonb)',            $p$coalesce((op->>'company_id')::int, 1)$p$,              $p$coalesce((op->>'company_id')::int, 2)$p$],
    array['public.stock_txn(jsonb,jsonb)',            $p$coalesce(nullif(it->>'company_id','')::int, 1)$p$,     $p$coalesce(nullif(it->>'company_id','')::int, 2)$p$],
    array['public.void_sale(bigint,text)',            $p$coalesce(it.company_id, 1)$p$,                         $p$coalesce(it.company_id, 2)$p$],
    array['public.approve_stock_request(bigint)',     $p$coalesce(v_req.company_id, 1)$p$,                      $p$coalesce(v_req.company_id, 2)$p$]
  ];
  i int;
begin
  for i in 1 .. array_length(pats, 1) loop
    fn := pats[i][1];
    if to_regprocedure(fn) is null then
      raise notice 'Function % not found — skipped', fn;
      continue;
    end if;
    d  := pg_get_functiondef(to_regprocedure(fn));
    d2 := replace(d, pats[i][2], pats[i][3]);
    if d2 = d then
      raise notice 'Fallback not found in % (already patched or different version) — guard triggers cover it', fn;
    else
      execute d2;
      raise notice 'Patched company fallback in %', fn;
    end if;
  end loop;
end $$;

-- 8. Guards: anything still written as company 1 (or no company) becomes 2.
--    For stock, an insert that would duplicate an existing company-2 row is
--    folded into that row instead, so it can never error or re-split stock.
create or replace function public.merge_guard_stock()
returns trigger language plpgsql as $$
begin
  if new.company_id is null or new.company_id = 1 then
    new.company_id := 2;
    if tg_op = 'INSERT' then
      update public.stock_by_location
         set quantity     = quantity     + coalesce(new.quantity, 0),
             box_quantity = box_quantity + coalesce(new.box_quantity, 0),
             updated_at   = now()
       where product_id = new.product_id and location_id = new.location_id and company_id = 2;
      if found then return null; end if;
    end if;
  end if;
  return new;
end $$;

create or replace function public.merge_guard_company()
returns trigger language plpgsql as $$
begin
  if new.company_id is null or new.company_id = 1 then new.company_id := 2; end if;
  return new;
end $$;

drop trigger if exists trg_merge_guard on public.stock_by_location;
create trigger trg_merge_guard before insert or update of company_id on public.stock_by_location
  for each row execute function public.merge_guard_stock();

drop trigger if exists trg_merge_guard on public.purchases;
create trigger trg_merge_guard before insert or update of company_id on public.purchases
  for each row execute function public.merge_guard_company();

drop trigger if exists trg_merge_guard on public.sale_items;
create trigger trg_merge_guard before insert or update of company_id on public.sale_items
  for each row execute function public.merge_guard_company();

drop trigger if exists trg_merge_guard on public.stock_requests;
create trigger trg_merge_guard before insert or update of company_id on public.stock_requests
  for each row execute function public.merge_guard_company();

-- 9. Remove Aadinath.
delete from public.companies where company_id = 1;

commit;

-- Summary (should show only company 2 everywhere).
select 'companies'         as tbl, company_id, count(*) from public.companies         group by company_id
union all
select 'stock_by_location',        company_id, count(*) from public.stock_by_location group by company_id
union all
select 'purchases',                company_id, count(*) from public.purchases         group by company_id
union all
select 'sale_items',               company_id, count(*) from public.sale_items        group by company_id
union all
select 'stock_requests',           company_id, count(*) from public.stock_requests    group by company_id
order by 1, 2;

-- ── Rollback (manual, only if ever needed) ──────────────────────────────────
--  1. drop the four trg_merge_guard triggers and the merge_guard_* functions.
--  2. insert into companies select * from _bak_merge_companies;
--  3. delete from stock_by_location where company_id in (1,2);
--     insert into stock_by_location select * from _bak_merge_stock_by_location;
--     (this restores stock as of the merge — later movements would be lost)
--  4. update purchases p set company_id = b.company_id from _bak_merge_purchases b where p.purchase_id = b.purchase_id;
--     update sale_items s set company_id = b.company_id from _bak_merge_sale_items b where s.<pk> = b.<pk>;
--     update stock_requests r set company_id = b.company_id from _bak_merge_stock_requests b where r.request_id = b.request_id;
--  5. re-run 06_companies.sql and 07_fixes.sql to restore the functions.
