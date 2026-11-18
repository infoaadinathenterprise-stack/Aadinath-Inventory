-- ============================================================================
--  21_printer_status_and_settings.sql  —  printer status + shared settings.
--  ADDITIVE and SAFE to run on a live database.
--
--  1. The helper on the printer laptop reports whether the sticker printer is
--     plugged in (relay_report); the Labels page shows it on every device.
--  2. Printer settings (label size, print-as, connection) are saved once in
--     print_settings and filled in automatically on every device — phone
--     included — instead of living in each browser separately.
-- ============================================================================

-- 1. Helper status --------------------------------------------------------------
alter table public.print_relays add column if not exists info jsonb;

create or replace function public.relay_report(p_secret text, p_info jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not print_relay_ok(p_secret) then
    raise exception 'Unknown printer helper' using errcode = '42501';
  end if;
  update print_relays
     set info = p_info, last_seen = now()
   where secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
end $$;
grant execute on function public.relay_report(text, jsonb) to anon, authenticated;

-- Website: is the printer laptop online, and is the printer plugged in?
create or replace function public.print_relay_status()
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare r print_relays;
begin
  if coalesce(public.app_role(), '') <> 'admin' then raise exception 'Admins only' using errcode = '42501'; end if;
  select * into r from print_relays order by last_seen desc nulls last limit 1;
  return jsonb_build_object('last_seen', r.last_seen, 'name', r.name, 'info', r.info);
end $$;
grant execute on function public.print_relay_status() to authenticated, anon;

-- 2. Shared printer settings (one row) -----------------------------------------
create table if not exists public.print_settings (
  id          integer     primary key default 1 check (id = 1),
  settings    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.print_settings enable row level security;
drop policy if exists p_print_settings_read on public.print_settings;
drop policy if exists p_print_settings_ins  on public.print_settings;
drop policy if exists p_print_settings_upd  on public.print_settings;
create policy p_print_settings_read on public.print_settings for select using (public.app_role() = 'admin');
create policy p_print_settings_ins  on public.print_settings for insert with check (public.app_role() = 'admin');
create policy p_print_settings_upd  on public.print_settings for update using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

insert into public.print_settings (id, settings)
values (1, '{"labelSize":"40x30","customWidthMm":40,"customHeightMm":30,"stickerMode":"piece","sendVia":"online","printerIp":"usb","printerPort":"9100"}')
on conflict (id) do nothing;

-- To undo:
--   drop table if exists public.print_settings;
--   drop function if exists public.relay_report(text, jsonb);
--   alter table public.print_relays drop column if exists info;
--   (and re-run print_relay_status from 18_print_queue.sql)
