-- ============================================================================
--  05_money_controls.sql  —  anti-theft / accountability controls (#5–#8).
--  Additive + replaces stock_txn with a version that enforces a staff price
--  floor. Safe to run on a live database. Run this BEFORE deploying the
--  matching app code (it adds RPCs the app will call).
-- ============================================================================

-- Audit trail for voided sales (#6).
alter table public.sales add column if not exists voided_by   text;
alter table public.sales add column if not exists voided_at   timestamptz;
alter table public.sales add column if not exists void_reason text;

-- ── stock_txn (replaces 03's) — now enforces a STAFF price floor (#5) ───────
--    Staff may not sell at zero/negative, nor below the product's real cost.
--    Admins are unrestricted (comps/clearance) but the true cost is still
--    snapshotted. The floor uses the server-side buying_price, so a browser
--    can't fake a low cost to slip under it.
create or replace function public.stock_txn(p_ops jsonb, p_sale jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text := auth.jwt() ->> 'app_role';
  v_user  text := coalesce(auth.jwt() ->> 'full_name', 'System');
  op      jsonb;
  it      jsonb;
  v_pid   int;  v_lid int;
  v_dq    int;  v_db  int;
  v_cq    int;  v_cb  int;
  v_nq    int;  v_nb  int;
  v_ppb   int;
  v_before int; v_after int;
  v_note  text;
  v_sale_id bigint;
  v_buy   numeric; v_ppb2 int; v_dunit text; v_unit text;
  v_uprice numeric; v_costbasis numeric; v_costsnap numeric;
begin
  if v_role not in ('admin', 'staff') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  for op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb))
  loop
    v_pid := (op->>'product_id')::int;
    v_lid := (op->>'location_id')::int;
    v_dq  := coalesce((op->>'dq')::int, 0);
    v_db  := coalesce((op->>'db')::int, 0);

    select quantity, box_quantity into v_cq, v_cb
      from stock_by_location
      where product_id = v_pid and location_id = v_lid
      for update;

    if not found then
      v_cq := 0; v_cb := 0;
      v_nq := v_dq; v_nb := v_db;
      if v_nq < 0 or v_nb < 0 then
        raise exception 'Not enough stock for product % at location %', v_pid, v_lid using errcode = '23514';
      end if;
      if v_nq <> 0 or v_nb <> 0 then
        insert into stock_by_location(product_id, location_id, quantity, box_quantity, updated_at)
        values (v_pid, v_lid, v_nq, v_nb, now());
      end if;
    else
      v_nq := v_cq + v_dq;
      v_nb := v_cb + v_db;
      if v_nq < 0 or v_nb < 0 then
        raise exception 'Not enough stock for product % at location %', v_pid, v_lid using errcode = '23514';
      end if;
      update stock_by_location
        set quantity = v_nq, box_quantity = v_nb, updated_at = now()
        where product_id = v_pid and location_id = v_lid;
    end if;

    if (op ? 'mov_type') and nullif(op->>'mov_type', '') is not null then
      select coalesce(pieces_per_box, 0) into v_ppb from products where product_id = v_pid;
      v_ppb := coalesce(v_ppb, 0);
      v_before := v_cq + v_cb * v_ppb;
      v_after  := v_nq + v_nb * v_ppb;
      v_note := format('[%s] %s (was: %s → now: %s)', v_user, coalesce(op->>'reason', ''), v_before, v_after);
      insert into stock_requests(product_id, request_type, quantity, from_location_id, to_location_id,
                                 notes, status, requested_at, approved_at)
      values (v_pid, op->>'mov_type', coalesce((op->>'mov_qty')::int, 0),
              nullif(op->>'mov_from', '')::int, nullif(op->>'mov_to', '')::int,
              v_note, 'APPROVED', now(), now());
    end if;
  end loop;

  if p_sale is not null then
    insert into sales(sale_date, performed_by, location_id, total_amount, item_count, notes, status)
    values (
      coalesce(nullif(p_sale->>'sale_date', ''), to_char(now(), 'YYYY-MM-DD'))::date,
      v_user,
      nullif(p_sale->>'location_id', '')::int,
      coalesce((p_sale->>'total_amount')::numeric, 0),
      coalesce((p_sale->>'item_count')::int, 0),
      p_sale->>'notes',
      'COMPLETED'
    )
    returning sale_id into v_sale_id;

    for it in select * from jsonb_array_elements(coalesce(p_sale->'items', '[]'::jsonb))
    loop
      v_uprice := nullif(it->>'unit_price', '')::numeric;
      v_unit   := it->>'unit';
      select coalesce(buying_price, 0), coalesce(pieces_per_box, 0), coalesce(display_unit, '')
        into v_buy, v_ppb2, v_dunit
        from products where product_id = nullif(it->>'product_id', '')::int;
      v_buy := coalesce(v_buy, 0); v_ppb2 := coalesce(v_ppb2, 0); v_dunit := coalesce(v_dunit, '');
      -- cost basis matches the unit sold (per-box when sold as the bulk unit)
      if v_ppb2 > 0 and v_dunit <> '' and lower(coalesce(v_unit, '')) = lower(v_dunit) then
        v_costbasis := v_buy * v_ppb2;
      else
        v_costbasis := v_buy;
      end if;

      if v_role = 'staff' and v_uprice is not null then
        if v_uprice <= 0 then
          raise exception 'Staff cannot sell "%" at zero price', coalesce(it->>'product_name', 'item') using errcode = '42501';
        end if;
        if v_buy > 0 and v_uprice < v_costbasis then
          raise exception 'Staff cannot sell "%" below cost (minimum %)', coalesce(it->>'product_name', 'item'), v_costbasis using errcode = '42501';
        end if;
      end if;

      -- Snapshot the authoritative per-unit cost (ignore any client value).
      v_costsnap := case when v_buy > 0 then v_costbasis else nullif(it->>'cost_price', '')::numeric end;

      insert into sale_items(sale_id, product_id, product_name, quantity, unit,
                             unit_price, cost_price, line_total)
      values (v_sale_id,
              nullif(it->>'product_id', '')::int,
              it->>'product_name',
              coalesce((it->>'quantity')::numeric, 0),
              it->>'unit',
              v_uprice,
              v_costsnap,
              nullif(it->>'line_total', '')::numeric);
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'sale_id', v_sale_id);
end;
$$;

-- ── void_sale (#6): admin-only, reason required, restocks + audits ──────────
--    A void now REVERSES the sale: it puts the stock back (to the sale's
--    location) and records who voided it, when, and why. So voiding can no
--    longer quietly erase revenue for goods that actually left — the stock
--    reappears, which a stock count will catch.
create or replace function public.void_sale(p_sale_id bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := auth.jwt() ->> 'app_role';
  v_user text := coalesce(auth.jwt() ->> 'full_name', 'System');
  v_sale sales%rowtype;
  it     sale_items%rowtype;
  v_lid  int;
  v_ppb  int; v_dunit text; v_pieces int;
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to void a sale'; end if;

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'COMPLETED' then raise exception 'Sale is already %', v_sale.status; end if;

  v_lid := coalesce(v_sale.location_id, 1);

  for it in select * from sale_items where sale_id = p_sale_id loop
    if it.product_id is not null and coalesce(it.quantity, 0) > 0 then
      select coalesce(pieces_per_box, 0), coalesce(display_unit, '') into v_ppb, v_dunit
        from products where product_id = it.product_id;
      v_ppb := coalesce(v_ppb, 0); v_dunit := coalesce(v_dunit, '');
      if v_ppb > 0 and v_dunit <> '' and lower(coalesce(it.unit, '')) = lower(v_dunit) then
        v_pieces := (it.quantity * v_ppb)::int;
      else
        v_pieces := it.quantity::int;
      end if;

      update stock_by_location set quantity = quantity + v_pieces, updated_at = now()
        where product_id = it.product_id and location_id = v_lid;
      if not found then
        insert into stock_by_location(product_id, location_id, quantity, box_quantity, updated_at)
        values (it.product_id, v_lid, v_pieces, 0, now());
      end if;

      insert into stock_requests(product_id, request_type, quantity, from_location_id, to_location_id,
                                 notes, status, requested_at, approved_at)
      values (it.product_id, 'ADJUSTMENT_IN', v_pieces, null, v_lid,
              format('[%s] Void sale #%s: %s', v_user, p_sale_id, p_reason), 'APPROVED', now(), now());
    end if;
  end loop;

  update sales set status = 'VOIDED', voided_by = v_user, voided_at = now(), void_reason = p_reason
    where sale_id = p_sale_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── add_withdrawal (#7): admin-only, reason required, actor from token ──────
--    The person recorded is taken from the signed login token, so a
--    withdrawal can't be attributed to someone else, and a reason + positive
--    amount are required.
create or replace function public.add_withdrawal(p_amount numeric, p_reason text, p_date text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := auth.jwt() ->> 'app_role';
  v_user text := coalesce(auth.jwt() ->> 'full_name', 'System');
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required for a withdrawal'; end if;
  insert into withdrawals(withdrawal_date, amount, reason, performed_by)
  values (coalesce(nullif(p_date, ''), to_char(now(), 'YYYY-MM-DD')), p_amount, btrim(p_reason), v_user);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.void_sale(bigint, text)              from public;
revoke execute on function public.add_withdrawal(numeric, text, text)  from public;
grant  execute on function public.void_sale(bigint, text)              to authenticated;
grant  execute on function public.add_withdrawal(numeric, text, text)  to authenticated;

-- To undo:
--   alter table public.sales drop column if exists voided_by, drop column if exists voided_at, drop column if exists void_reason;
--   drop function if exists public.void_sale(bigint, text);
--   drop function if exists public.add_withdrawal(numeric, text, text);
--   (and re-run 03_stock_functions.sql to restore the floor-free stock_txn)
