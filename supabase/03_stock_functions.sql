-- ============================================================================
--  03_stock_functions.sql  —  Atomic, race-safe stock engine.
--  ADDITIVE and safe to run on a live database: it only CREATES functions.
--  Nothing changes until the app calls them. To undo, see the drop block at
--  the bottom.
--
--  Why: stock used to be changed by the browser (read a number, do math,
--  write it back), which loses updates when two people act at once and can
--  leave a half-finished sale. These functions do the whole change inside
--  one database transaction, locking each stock row, applying the change as
--  a DELTA against the REAL current value, and refusing to go negative.
-- ============================================================================

-- ── stock_txn: apply a batch of stock deltas (+ optionally record a sale) ────
--    p_ops  = array of:
--      { product_id, location_id, dq, db,             -- delta loose / delta boxes
--        mov_type, mov_qty, mov_from, mov_to, reason } -- movement log (optional)
--    p_sale = null, or:
--      { sale_date, location_id, total_amount, item_count, notes,
--        items: [ { product_id, product_name, quantity, unit,
--                   unit_price, cost_price, line_total } ] }
--    Everything runs in ONE transaction. Any failure rolls the whole thing
--    back. Returns { ok, sale_id }.
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

    -- Lock the row so concurrent transactions serialize on it.
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

    -- Movement log (accurate before/after from the locked read).
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

  -- Optional sale header + line items, in the same transaction.
  if p_sale is not null then
    insert into sales(sale_date, performed_by, location_id, total_amount, item_count, notes, status)
    values (
      coalesce(p_sale->>'sale_date', to_char(now(), 'YYYY-MM-DD')),
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
      insert into sale_items(sale_id, product_id, product_name, quantity, unit,
                             unit_price, cost_price, line_total)
      values (v_sale_id,
              nullif(it->>'product_id', '')::int,
              it->>'product_name',
              coalesce((it->>'quantity')::numeric, 0),
              it->>'unit',
              nullif(it->>'unit_price', '')::numeric,
              nullif(it->>'cost_price', '')::numeric,
              nullif(it->>'line_total', '')::numeric);
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'sale_id', v_sale_id);
end;
$$;

-- ── approve_stock_request: atomic approval (admin only) ─────────────────────
--    Locks the request, ensures it's still PENDING (no double-approve race),
--    adds the stock, and marks it approved — all in one transaction.
create or replace function public.approve_stock_request(p_request_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := auth.jwt() ->> 'app_role';
  v_req  stock_requests%rowtype;
  v_lid  int;
  v_exists boolean;
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;

  select * into v_req from stock_requests where request_id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'PENDING' then raise exception 'Request is already %', v_req.status; end if;

  v_lid := coalesce(v_req.to_location_id, 1);

  perform 1 from stock_by_location where product_id = v_req.product_id and location_id = v_lid for update;
  v_exists := found;
  if v_exists then
    update stock_by_location set quantity = quantity + v_req.quantity, updated_at = now()
      where product_id = v_req.product_id and location_id = v_lid;
  else
    insert into stock_by_location(product_id, location_id, quantity, box_quantity, updated_at)
    values (v_req.product_id, v_lid, v_req.quantity, 0, now());
  end if;

  update stock_requests set status = 'APPROVED', approved_at = now() where request_id = p_request_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── reject_stock_request: atomic reject (admin only) ────────────────────────
create or replace function public.reject_stock_request(p_request_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := auth.jwt() ->> 'app_role';
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;
  update stock_requests set status = 'REJECTED', approved_at = now()
    where request_id = p_request_id and status = 'PENDING';
  if not found then raise exception 'Request is not pending or does not exist'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Only logged-in users may call these; never the anonymous public key.
revoke execute on function public.stock_txn(jsonb, jsonb)          from public;
revoke execute on function public.approve_stock_request(bigint)    from public;
revoke execute on function public.reject_stock_request(bigint)     from public;
grant  execute on function public.stock_txn(jsonb, jsonb)          to authenticated;
grant  execute on function public.approve_stock_request(bigint)    to authenticated;
grant  execute on function public.reject_stock_request(bigint)     to authenticated;

-- ── To undo everything this file created: ───────────────────────────────────
--   drop function if exists public.stock_txn(jsonb, jsonb);
--   drop function if exists public.approve_stock_request(bigint);
--   drop function if exists public.reject_stock_request(bigint);
