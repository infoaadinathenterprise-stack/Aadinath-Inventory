-- ============================================================================
--  28_relay_fewer_writes.sql  —  stop the printer helper burning Disk IO.
--  SAFE to run on a live database (replaces two functions from 20 / 21).
--
--  Why: the helper on the printer PC calls relay_claim_print_jobs every 2 s
--  and relay_report every 15 s, and both rewrote print_relays.last_seen every
--  time — ~50,000 writes a day, which drained the free plan's Disk IO budget
--  (Supabase email, 20 Nov 2026). Now last_seen is only written when it is
--  10+ s old (the Labels page calls the helper "online" under 20 s), and
--  info only when it changed. Jobs are claimed exactly as before.
-- ============================================================================

create or replace function public.relay_claim_print_jobs(p_secret text)
returns setof public.print_jobs
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_relays set last_seen = now()
   where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     and (last_seen is null or last_seen < now() - interval '10 seconds');
  -- Waiting too long: the printer PC was off when it was sent.
  update print_jobs set status = 'failed', finished_at = now(),
         message = 'Not printed: the printer PC was not online within 10 minutes'
   where status = 'pending' and created_at < now() - interval '10 minutes';
  -- Claimed but never reported back: the helper stopped mid-job.
  update print_jobs set status = 'failed', finished_at = now(),
         message = 'Printer PC stopped while printing — check the labels and send again if needed'
   where status = 'printing' and coalesce(claimed_at, created_at) < now() - interval '5 minutes';
  return query
    update print_jobs set status = 'printing', claimed_at = now()
     where job_id in (select job_id from print_jobs where status = 'pending'
                       order by job_id limit 5 for update skip locked)
    returning *;
end $$;
grant execute on function public.relay_claim_print_jobs(text) to anon, authenticated;

create or replace function public.relay_report(p_secret text, p_info jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_relays
     set info = p_info, last_seen = now()
   where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     and (info is distinct from p_info or last_seen is null or last_seen < now() - interval '10 seconds');
end $$;
grant execute on function public.relay_report(text, jsonb) to anon, authenticated;

-- To undo: re-run supabase/20_print_queue_recover.sql and the relay_report
-- part of supabase/21_printer_status_and_settings.sql.
