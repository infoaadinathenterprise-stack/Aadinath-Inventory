-- ============================================================================
--  17_transporters.sql  —  transporters, and which one delivered each bill.
--  ADDITIVE and SAFE to run on a live database: one new table and one
--  nullable column.
--
--  Why: the Suppliers page becomes "Suppliers / Transporters" with a list of
--  transport companies, and each purchase bill can record its transporter
--  (picked from a dropdown on New / Edit Purchase). Transporters are their
--  own table so they never appear in supplier pickers.
-- ============================================================================

create table if not exists public.transporters (
  transporter_id   bigserial   primary key,
  transporter_name text        not null,
  phone            text,
  address          text,
  notes            text,
  active_status    boolean     not null default true,
  created_at       timestamptz not null default now()
);

alter table public.purchases add column if not exists transporter_id integer;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Same as suppliers' management: admins only.
alter table public.transporters enable row level security;
drop policy if exists p_transporters_read on public.transporters;
drop policy if exists p_transporters_ins  on public.transporters;
drop policy if exists p_transporters_upd  on public.transporters;
create policy p_transporters_read on public.transporters for select using (public.app_role() = 'admin');
create policy p_transporters_ins  on public.transporters for insert with check (public.app_role() = 'admin');
create policy p_transporters_upd  on public.transporters for update using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

-- To undo:
--   alter table public.purchases drop column if exists transporter_id;
--   drop table if exists public.transporters;
