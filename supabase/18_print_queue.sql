-- ============================================================================
--  18_print_queue.sql  —  sticker print jobs that any device can send.
--  ADDITIVE and SAFE to run on a live database.
--
--  Why: the sticker printer is plugged into one PC by USB. The Labels page
--  used to post straight to a helper on that PC, which only worked on the PC
--  itself (a phone can't reliably reach it). Now the page puts the job in
--  this table, and the helper on the printer PC (sticker-relay/server.js)
--  picks it up, prints it and marks it done — from any device, anywhere.
--
--  The helper has no login. It proves itself with a long random secret kept
--  on the printer PC; only the secret's SHA-256 hash is stored here, in a
--  table the website cannot read.
-- ============================================================================

create table if not exists public.print_jobs (
  job_id       bigserial   primary key,
  created_at   timestamptz not null default now(),
  payload      jsonb       not null,                 -- { printerIp, printerPort, jobs: [...] }
  label_count  integer     not null default 0,
  status       text        not null default 'pending'
               check (status in ('pending', 'printing', 'done', 'failed')),
  message      text,
  finished_at  timestamptz
);
create index if not exists print_jobs_pending_idx on public.print_jobs (job_id) where status = 'pending';

alter table public.print_jobs enable row level security;
drop policy if exists p_print_jobs_read on public.print_jobs;
drop policy if exists p_print_jobs_ins  on public.print_jobs;
create policy p_print_jobs_read on public.print_jobs for select using (public.app_role() = 'admin');
create policy p_print_jobs_ins  on public.print_jobs for insert with check (public.app_role() = 'admin' and status = 'pending');

-- Helper secrets (hash only). RLS on, no policies: invisible to the website.
create table if not exists public.print_relays (
  secret_hash text        primary key,
  name        text,
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.print_relays enable row level security;

create or replace function public.print_relay_ok(p_secret text)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from print_relays
                 where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex'));
$$;
revoke all on function public.print_relay_ok(text) from public, anon, authenticated;

-- Helper: take the next waiting jobs. Jobs nobody picked up within 10 minutes
-- (printer PC was off) are failed instead, so they don't print by surprise later.
create or replace function public.relay_claim_print_jobs(p_secret text)
returns setof public.print_jobs
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_relays set last_seen = now()
   where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  update print_jobs set status = 'failed', finished_at = now(),
         message = 'Not printed: the printer PC was not online within 10 minutes'
   where status = 'pending' and created_at < now() - interval '10 minutes';
  return query
    update print_jobs set status = 'printing'
     where job_id in (select job_id from print_jobs where status = 'pending'
                       order by job_id limit 5 for update skip locked)
    returning *;
end $$;

create or replace function public.relay_finish_print_job(p_secret text, p_job_id bigint, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_jobs
     set status = case when p_ok then 'done' else 'failed' end,
         message = left(p_message, 500), finished_at = now()
   where job_id = p_job_id and status = 'printing';
end $$;

-- Website: is the printer PC online? (seconds since the helper last checked in)
create or replace function public.print_relay_status()
returns jsonb
language plpgsql security definer set search_path = public stable as $$
begin
  if coalesce(public.app_role(), '') <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;
  return jsonb_build_object('last_seen', (select max(last_seen) from print_relays));
end $$;

grant execute on function public.relay_claim_print_jobs(text) to anon, authenticated;
grant execute on function public.relay_finish_print_job(text, bigint, boolean, text) to anon, authenticated;
grant execute on function public.print_relay_status() to authenticated, anon;

-- To register the helper, run separately (the hash comes from the printer PC):
--   insert into public.print_relays (secret_hash, name) values ('<sha256 hex>', 'Shop PC');
--
-- To undo:
--   drop function if exists public.relay_claim_print_jobs(text);
--   drop function if exists public.relay_finish_print_job(text, bigint, boolean, text);
--   drop function if exists public.print_relay_status();
--   drop function if exists public.print_relay_ok(text);
--   drop table if exists public.print_relays;
--   drop table if exists public.print_jobs;
