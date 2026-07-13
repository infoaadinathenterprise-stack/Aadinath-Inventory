-- ============================================================================
--  06_companies.sql  —  Aadinath / Jay Aadinath company split (Stage 1).
--  Adds a company dimension to stock, purchases and sale lines. SAFE to run
--  on a live database: all existing stock and purchases are assigned to
--  Aadinath (company 1), and the engine defaults to Aadinath, so nothing
--  changes behaviourally until the new UI starts sending a company.
-- ============================================================================

-- 1. Companies
create table if not exists public.companies (
  company_id    serial primary key,
  company_name  text not null,
  active_status boolean not null default true,
  created_at    timestamptz not null default now()
);
insert into public.companies (company_id, company_name)
  select 1, 'Aadinath Enterprise'      where not exists (select 1 from public.companies where company_id = 1);
insert into public.companies (company_id, company_name)
  select 2, 'Jay Aadinath Enterprise'  where not exists (select 1 from public.companies where company_id = 2);
select setval(pg_get_serial_sequence('public.companies','company_id'),
              greatest((select max(company_id) from public.companies), 1));

-- 2. Company columns (existing rows -> Aadinath = 1)
alter table public.stock_by_location add column if not exists company_id integer not null default 1;
alter table public.purchases         add column if not exists company_id integer not null default 1;
alter table public.sale_items        add column if not exists company_id integer;

-- 3. Stock is now unique per (product, location, company). Drop any old
--    unique on just (product, location) first, or a second company at the
--    same product+location would be rejected.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.stock_by_location'::regclass and contype = 'u'
      and (select array(select a.attname::text from unnest(conkey) as k(attnum)
                        join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum
                        order by a.attname)) = array['location_id','product_id']
  loop
    execute 'alter table public.stock_by_location drop constraint ' || quote_ident(r.conname);
  end loop;
  for r in
    select ic.relname as idxname from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = 'public.stock_by_location'::regclass and i.indisunique
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
      and (select array(select a.attname::text from unnest(i.indkey) as k(attnum)
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                        order by a.attname)) = array['location_id','product_id']
  loop
    execute 'drop index if exists public.' || quote_ident(r.idxname);
  end loop;
end $$;
create unique index if not exists stock_by_location_plc_uniq
  on public.stock_by_location (product_id, location_id, company_id);

-- 4. Company-aware stock engine (replaces the previous stock_txn). Each op
--    may carry a company_id (defaults to Aadinath = 1); stock is keyed by
--    (product, location, company). Sale lines record their company too.
create or replace function public.stock_txn(p_ops jsonb, p_sale jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := auth.jwt() ->> 'app_role';
  v_user text := coalesce(auth.jwt() ->> 'full_name', 'System');
  op jsonb; it jsonb;
  v_pid int; v_lid int; v_cid int; v_dq int; v_db int; v_cq int; v_cb int; v_nq int; v_nb int;
  v_ppb int; v_before int; v_after int; v_note text; v_sale_id bigint;
  v_buy numeric; v_ppb2 int; v_dunit text; v_unit text;
  v_uprice numeric; v_costbasis numeric; v_costsnap numeric;
begin
  if v_role not in ('admin','staff') then raise exception 'Not authorized' using errcode='42501'; end if;
  for op in select * from jsonb_array_elements(coalesce(p_ops,'[]'::jsonb)) loop
    v_pid := (op->>'product_id')::int; v_lid := (op->>'location_id')::int;
    v_cid := coalesce((op->>'company_id')::int, 1);
    v_dq := coalesce((op->>'dq')::int,0); v_db := coalesce((op->>'db')::int,0);
    select quantity, box_quantity into v_cq, v_cb from stock_by_location
      where product_id=v_pid and location_id=v_lid and company_id=v_cid for update;
    if not found then
      v_cq:=0; v_cb:=0; v_nq:=v_dq; v_nb:=v_db;
      if v_nq<0 or v_nb<0 then raise exception 'Not enough stock for product % at location %', v_pid, v_lid using errcode='23514'; end if;
      if v_nq<>0 or v_nb<>0 then insert into stock_by_location(product_id,location_id,company_id,quantity,box_quantity,updated_at) values (v_pid,v_lid,v_cid,v_nq,v_nb,now()); end if;
    else
      v_nq:=v_cq+v_dq; v_nb:=v_cb+v_db;
      if v_nq<0 or v_nb<0 then raise exception 'Not enough stock for product % at location %', v_pid, v_lid using errcode='23514'; end if;
      update stock_by_location set quantity=v_nq, box_quantity=v_nb, updated_at=now() where product_id=v_pid and location_id=v_lid and company_id=v_cid;
    end if;
    if (op ? 'mov_type') and nullif(op->>'mov_type','') is not null then
      select coalesce(pieces_per_box,0) into v_ppb from products where product_id=v_pid;
      v_ppb:=coalesce(v_ppb,0); v_before:=v_cq+v_cb*v_ppb; v_after:=v_nq+v_nb*v_ppb;
      v_note := format('[%s] %s (was: %s → now: %s)', v_user, coalesce(op->>'reason',''), v_before, v_after);
      insert into stock_requests(product_id,request_type,quantity,from_location_id,to_location_id,notes,status,requested_at,approved_at)
      values (v_pid, op->>'mov_type', coalesce((op->>'mov_qty')::int,0), nullif(op->>'mov_from','')::int, nullif(op->>'mov_to','')::int, v_note, 'APPROVED', now(), now());
    end if;
  end loop;
  if p_sale is not null then
    insert into sales(sale_date, performed_by, location_id, total_amount, item_count, notes, status)
    values (coalesce(nullif(p_sale->>'sale_date',''), to_char(now(),'YYYY-MM-DD'))::date, v_user,
            nullif(p_sale->>'location_id','')::int, coalesce((p_sale->>'total_amount')::numeric,0),
            coalesce((p_sale->>'item_count')::int,0), p_sale->>'notes', 'COMPLETED')
    returning sale_id into v_sale_id;
    for it in select * from jsonb_array_elements(coalesce(p_sale->'items','[]'::jsonb)) loop
      v_uprice := nullif(it->>'unit_price','')::numeric; v_unit := it->>'unit';
      select coalesce(buying_price,0), coalesce(pieces_per_box,0), coalesce(display_unit,'')
        into v_buy, v_ppb2, v_dunit from products where product_id = nullif(it->>'product_id','')::int;
      v_buy:=coalesce(v_buy,0); v_ppb2:=coalesce(v_ppb2,0); v_dunit:=coalesce(v_dunit,'');
      if v_ppb2>0 and v_dunit<>'' and lower(coalesce(v_unit,''))=lower(v_dunit) then v_costbasis:=v_buy*v_ppb2; else v_costbasis:=v_buy; end if;
      if v_role='staff' and v_uprice is not null then
        if v_uprice<=0 then raise exception 'Staff cannot sell "%" at zero price', coalesce(it->>'product_name','item') using errcode='42501'; end if;
        if v_buy>0 and v_uprice<v_costbasis then raise exception 'Staff cannot sell "%" below cost (minimum %)', coalesce(it->>'product_name','item'), v_costbasis using errcode='42501'; end if;
      end if;
      v_costsnap := case when v_buy>0 then v_costbasis else nullif(it->>'cost_price','')::numeric end;
      insert into sale_items(sale_id,product_id,product_name,quantity,unit,unit_price,cost_price,line_total,company_id)
      values (v_sale_id, nullif(it->>'product_id','')::int, it->>'product_name', coalesce((it->>'quantity')::numeric,0),
              it->>'unit', v_uprice, v_costsnap, nullif(it->>'line_total','')::numeric,
              coalesce(nullif(it->>'company_id','')::int, 1));
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'sale_id', v_sale_id);
end; $$;

-- 5. Convert a whole purchase to another company: move each item's quantity of
--    stock from the purchase's current company to the new one, at the item's
--    recorded location (or drained across locations if none was recorded),
--    capped at what's actually still in stock — so partially-sold purchases
--    move only what remains and never go negative. Retags the purchase.
create or replace function public.convert_purchase_company(p_purchase_id bigint, p_company_id int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := auth.jwt() ->> 'app_role';
  v_user text := coalesce(auth.jwt() ->> 'full_name','System');
  v_old int; v_cname text; it record; loc record;
  v_remaining int; v_take int; v_avail int; v_moved int := 0;
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode='42501'; end if;
  if not exists (select 1 from companies where company_id = p_company_id) then raise exception 'Unknown company'; end if;
  select company_id into v_old from purchases where purchase_id = p_purchase_id for update;
  if not found then raise exception 'Purchase not found'; end if;
  select company_name into v_cname from companies where company_id = p_company_id;
  if v_old = p_company_id then return jsonb_build_object('ok', true, 'moved', 0); end if;

  for it in select product_id, quantity, location_id from purchase_items
            where purchase_id = p_purchase_id and product_id is not null and coalesce(quantity,0) > 0
  loop
    v_remaining := it.quantity;
    for loc in
      select location_id from stock_by_location
      where product_id = it.product_id and company_id = v_old and quantity > 0
        and (it.location_id is null or location_id = it.location_id)
      order by (case when it.location_id is not null and location_id = it.location_id then 0 else 1 end), location_id
    loop
      exit when v_remaining <= 0;
      select quantity into v_avail from stock_by_location
        where product_id=it.product_id and location_id=loc.location_id and company_id=v_old for update;
      v_take := least(v_remaining, coalesce(v_avail,0));
      if v_take > 0 then
        update stock_by_location set quantity = quantity - v_take, updated_at=now()
          where product_id=it.product_id and location_id=loc.location_id and company_id=v_old;
        update stock_by_location set quantity = quantity + v_take, updated_at=now()
          where product_id=it.product_id and location_id=loc.location_id and company_id=p_company_id;
        if not found then
          insert into stock_by_location(product_id,location_id,company_id,quantity,box_quantity,updated_at)
          values (it.product_id, loc.location_id, p_company_id, v_take, 0, now());
        end if;
        insert into stock_requests(product_id,request_type,quantity,from_location_id,to_location_id,notes,status,requested_at,approved_at)
        values (it.product_id,'ADJUSTMENT_IN',v_take,null,loc.location_id,
                format('[%s] Purchase #%s moved to %s', v_user, p_purchase_id, v_cname),'APPROVED',now(),now());
        v_remaining := v_remaining - v_take;
        v_moved := v_moved + v_take;
      end if;
    end loop;
  end loop;

  update purchases set company_id = p_company_id where purchase_id = p_purchase_id;
  return jsonb_build_object('ok', true, 'moved', v_moved);
end; $$;

-- 6. void_sale now restocks each line to ITS company.
create or replace function public.void_sale(p_sale_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := auth.jwt() ->> 'app_role'; v_user text := coalesce(auth.jwt() ->> 'full_name','System');
  v_sale sales%rowtype; it sale_items%rowtype; v_lid int; v_cid int; v_ppb int; v_dunit text; v_pieces int;
begin
  if v_role<>'admin' then raise exception 'Admins only' using errcode='42501'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'A reason is required to void a sale'; end if;
  select * into v_sale from sales where sale_id=p_sale_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status<>'COMPLETED' then raise exception 'Sale is already %', v_sale.status; end if;
  v_lid := coalesce(v_sale.location_id,1);
  for it in select * from sale_items where sale_id=p_sale_id loop
    if it.product_id is not null and coalesce(it.quantity,0)>0 then
      v_cid := coalesce(it.company_id, 1);
      select coalesce(pieces_per_box,0), coalesce(display_unit,'') into v_ppb, v_dunit from products where product_id=it.product_id;
      v_ppb:=coalesce(v_ppb,0); v_dunit:=coalesce(v_dunit,'');
      if v_ppb>0 and v_dunit<>'' and lower(coalesce(it.unit,''))=lower(v_dunit) then v_pieces:=(it.quantity*v_ppb)::int; else v_pieces:=it.quantity::int; end if;
      update stock_by_location set quantity=quantity+v_pieces, updated_at=now() where product_id=it.product_id and location_id=v_lid and company_id=v_cid;
      if not found then insert into stock_by_location(product_id,location_id,company_id,quantity,box_quantity,updated_at) values (it.product_id,v_lid,v_cid,v_pieces,0,now()); end if;
      insert into stock_requests(product_id,request_type,quantity,from_location_id,to_location_id,notes,status,requested_at,approved_at)
      values (it.product_id,'ADJUSTMENT_IN',v_pieces,null,v_lid, format('[%s] Void sale #%s: %s', v_user, p_sale_id, p_reason),'APPROVED',now(),now());
    end if;
  end loop;
  update sales set status='VOIDED', voided_by=v_user, voided_at=now(), void_reason=p_reason where sale_id=p_sale_id;
  return jsonb_build_object('ok', true);
end; $$;

-- 7. RLS + grants
alter table public.companies enable row level security;
drop policy if exists p_companies_read  on public.companies;
drop policy if exists p_companies_write on public.companies;
create policy p_companies_read  on public.companies for select using (true);
create policy p_companies_write on public.companies for all using (public.is_admin()) with check (public.is_admin());

revoke execute on function public.convert_purchase_company(bigint, int) from public;
grant  execute on function public.convert_purchase_company(bigint, int) to authenticated;
