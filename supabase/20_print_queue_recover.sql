-- ============================================================================
--  20_print_queue_recover.sql  —  print jobs can't get stuck on "printing".
--  SAFE to run on a live database (replaces one function from 18).
--
--  Why: the printer PC claims up to 5 jobs at a time and marks them
--  'printing'. If the helper crashed or the PC was switched off mid-batch,
--  those jobs stayed 'printing' forever — never printed, never failed, and the
--  Labels page could only say "no reply". Now a job still 'printing' after
--  5 minutes is marked failed (not re-printed: some labels may already have
--  come out, so re-sending it is the user's call).
-- ============================================================================

-- When the helper took the job (the 5-minute clock starts here).
alter table public.print_jobs add column if not exists claimed_at timestamptz;

create or replace function public.relay_claim_print_jobs(p_secret text)
returns setof public.print_jobs
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_relays set last_seen = now()
   where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
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
