-- ============================================================================
--  01_security_setup.sql   —  ADDITIVE, run this FIRST
--  Safe to run on a live database. It does NOT change who can read/write
--  anything yet (that's 02_enable_rls.sql). It only adds the columns,
--  helper, and guard that the new login system needs.
--  Run in: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- ============================================================================

-- 1. Column to hold the hashed PIN. The old plaintext `pin` column is kept
--    for now so nobody is locked out; the login function auto-migrates each
--    user to pin_hash the next time they log in. Once everyone has logged in
--    at least once, you can drop it (see the note at the bottom).
alter table public.app_users add column if not exists pin_hash text;

-- 2. Helper: the signed login token carries the user's role in the
--    `app_role` claim. This reads it out so RLS policies stay readable.
create or replace function public.app_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'app_role', '')
$$;

-- 3. Guard: never allow the last active admin to be demoted or deactivated,
--    so a rogue admin can't lock the owner out of the business. This fires
--    even for the server function (service role bypasses RLS, not triggers).
create or replace function public.prevent_last_admin_lockout()
returns trigger
language plpgsql
as $$
declare
  remaining_admins int;
begin
  if (old.role = 'admin' and old.active_status = true)
     and (new.role <> 'admin' or new.active_status = false) then
    select count(*) into remaining_admins
      from public.app_users
     where role = 'admin'
       and active_status = true
       and user_id <> old.user_id;
    if remaining_admins = 0 then
      raise exception 'Cannot deactivate or demote the last active admin';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_last_admin on public.app_users;
create trigger trg_prevent_last_admin
  before update on public.app_users
  for each row execute function public.prevent_last_admin_lockout();

-- ── After every user has logged in once (so pin_hash is filled), you can
--    permanently remove the plaintext column with:
--        alter table public.app_users drop column pin;
--    (Don't run this line until you've confirmed logins work.)
