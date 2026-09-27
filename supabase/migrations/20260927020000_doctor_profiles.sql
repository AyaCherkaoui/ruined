-- Apply after 20260927010000_aggregate_alert_compatibility.sql. Additive: touches no other table.
-- One profile per Supabase Auth user. Professional details only: no password (Supabase Auth
-- keeps credentials), no patient data, no PHI. Safe to re-run.

create table if not exists public.doctor_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  name         text check (char_length(name) <= 200),
  npi          text check (npi ~ '^[0-9]{10}$'),
  specialty    text check (char_length(specialty) <= 200),
  organization text check (char_length(organization) <= 200),
  phone        text check (char_length(phone) <= 40),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Keep updated_at current on every update.
create or replace function public.doctor_profiles_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists doctor_profiles_touch_updated_at on public.doctor_profiles;
create trigger doctor_profiles_touch_updated_at
  before update on public.doctor_profiles
  for each row execute function public.doctor_profiles_touch_updated_at();

-- Row level security: a signed-in doctor reads and updates only their own row. There is no
-- insert or delete policy, so profiles are created by an admin (SQL Editor), not by users.
alter table public.doctor_profiles enable row level security;

revoke all on public.doctor_profiles from anon, authenticated;
grant select on public.doctor_profiles to authenticated;
-- Column-level: doctors cannot change user_id or the timestamps.
grant update (name, npi, specialty, organization, phone) on public.doctor_profiles to authenticated;

drop policy if exists "Doctors read their own profile" on public.doctor_profiles;
create policy "Doctors read their own profile"
  on public.doctor_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Doctors update their own profile" on public.doctor_profiles;
create policy "Doctors update their own profile"
  on public.doctor_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
