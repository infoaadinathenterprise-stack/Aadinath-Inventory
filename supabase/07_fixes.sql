-- ============================================================================
--  07_fixes.sql  —  post-company-split correctness fixes.
--  Additive + replaces one function. SAFE to run on a live database.
--  Run this in Supabase (SQL editor) BEFORE deploying the matching app code.
-- ============================================================================

-- ── FIX 1: approve_stock_request was company-BLIND ──────────────────────────
--  Background: 06_companies.sql made stock unique per (product, location,
--  company). But approve_stock_request (from 03_stock_functions.sql) was
--  never updated — it added the approved quantity with:
--      update stock_by_location ... where product_id=? and location_id=?
--  i.e. NO company filter. When a product has a row for BOTH companies at
--  that location, that UPDATE hits BOTH rows, so approving a single staff
--  stock-in request silently credits the quantity to EVERY company —
--  inventing stock that was never bought. This inflates inventory and the
--  stock valuation. The fix credits exactly one company (the one recorded on
--  the request, defaulting to Aadinath = 1).

-- Record which company a pending stock-in request is for. Existing rows and
-- any older client that doesn't send it default to Aadinath (1), matching the
-- app's default company, so nothing breaks before the new client deploys.
alter table public.stock_requests add column if not exists company_id integer not null default 1;

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
  v_cid  int;
  v_exists boolean;
begin
  if v_role <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;

  select * into v_req from stock_requests where request_id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'PENDING' then raise exception 'Request is already %', v_req.status; end if;

  v_lid := coalesce(v_req.to_location_id, 1);
  v_cid := coalesce(v_req.company_id, 1);

  -- Lock + credit exactly ONE company's row (never all of them).
  perform 1 from stock_by_location
    where product_id = v_req.product_id and location_id = v_lid and company_id = v_cid
    for update;
  v_exists := found;
  if v_exists then
    update stock_by_location set quantity = quantity + v_req.quantity, updated_at = now()
      where product_id = v_req.product_id and location_id = v_lid and company_id = v_cid;
  else
    insert into stock_by_location(product_id, location_id, company_id, quantity, box_quantity, updated_at)
    values (v_req.product_id, v_lid, v_cid, v_req.quantity, 0, now());
  end if;

  update stock_requests set status = 'APPROVED', approved_at = now() where request_id = p_request_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.approve_stock_request(bigint) from public;
grant  execute on function public.approve_stock_request(bigint) to authenticated;

-- To undo FIX 1:
--   re-run 03_stock_functions.sql (restores the old company-blind version)
--   alter table public.stock_requests drop column if exists company_id;
