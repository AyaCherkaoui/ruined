-- Shared synthetic demo fixtures; CMS evidence is immutable to application users.
-- JSONB retains the existing versioned API contract without reimplementing the cost engine.
create table public.demo_source_releases (
  id text primary key, source_url text not null, sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  release_date date not null, verified_at timestamptz not null, evidence jsonb not null
);
create table public.demo_doctors (id text primary key, full_name text not null, phone text);
create table public.demo_patients (
  id text primary key, doctor_id text not null references public.demo_doctors(id), full_name text not null,
  is_synthetic boolean not null default true check (is_synthetic), plan jsonb not null, prescriptions jsonb not null
);
create index demo_patients_doctor_idx on public.demo_patients(doctor_id);
create table public.demo_coverage_checks (
  id text primary key, contract_id text not null, plan_id text not null, segment_id text not null,
  rxcui text not null, plan_name text not null, data_version text not null references public.demo_source_releases(id),
  result jsonb not null, ndcs jsonb not null,
  unique(contract_id,plan_id,segment_id,rxcui)
);
create index demo_checks_version_idx on public.demo_coverage_checks(data_version);
create table public.demo_changes (id text primary key, payload jsonb not null);
create table public.demo_patient_alerts (
  id text primary key, doctor_id text not null references public.demo_doctors(id),
  patient_id text not null references public.demo_patients(id),
  check_id text not null references public.demo_coverage_checks(id),
  change_id text not null references public.demo_changes(id), payload jsonb not null
);
create index demo_alerts_doctor_idx on public.demo_patient_alerts(doctor_id);
create index demo_alerts_patient_idx on public.demo_patient_alerts(patient_id);
create index demo_alerts_check_idx on public.demo_patient_alerts(check_id);
create index demo_alerts_change_idx on public.demo_patient_alerts(change_id);
create table public.demo_patient_reviews (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  alert_id text not null references public.demo_patient_alerts(id),
  status text not null check (status in ('new','seen','switched','dismissed')),
  selected_rxcui text, saved_at timestamptz,
  primary key(user_id,alert_id), check ((selected_rxcui is null) = (saved_at is null))
);
create index demo_reviews_alert_idx on public.demo_patient_reviews(alert_id);
create table public.demo_notification_receipts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null, result jsonb not null, created_at timestamptz not null default now(), primary key(user_id,id)
);

do $$
declare t text;
begin
  foreach t in array array['demo_source_releases','demo_doctors','demo_patients','demo_coverage_checks','demo_changes','demo_patient_alerts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    -- Intentionally shared fixtures: all identities and enrollments are synthetic.
    execute format('create policy demo_fixture_read on public.%I for select to authenticated using (true)',t);
  end loop;
  foreach t in array array['demo_patient_reviews','demo_notification_receipts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to authenticated',t);
    execute format('create policy own_rows on public.%I for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',t);
  end loop;
end $$;

create function public.validate_demo_review() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.selected_rxcui is not null and not exists (
    select 1 from public.demo_patient_alerts a join public.demo_coverage_checks c on c.id=a.check_id,
    lateral jsonb_array_elements(c.result->'alternatives') alt
    where a.id=new.alert_id and alt->>'rxcui'=new.selected_rxcui
  ) then raise exception 'Alternative is not offered for this plan' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.validate_demo_review() from public, anon, authenticated;
create trigger validate_demo_review before insert or update on public.demo_patient_reviews for each row execute function public.validate_demo_review();

create function public.select_demo_alternative(p_alert_id text,p_rxcui text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  insert into public.demo_patient_reviews(user_id,alert_id,status,selected_rxcui,saved_at)
  values(auth.uid(),p_alert_id,'seen',p_rxcui,now())
  on conflict(user_id,alert_id) do update set status='seen',selected_rxcui=excluded.selected_rxcui,
    saved_at=case when demo_patient_reviews.selected_rxcui=excluded.selected_rxcui then demo_patient_reviews.saved_at else excluded.saved_at end;
end $$;
create function public.reset_demo_reviews() returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  insert into public.demo_patient_reviews(user_id,alert_id,status,selected_rxcui,saved_at)
  select auth.uid(),id,'new',null,null from public.demo_patient_alerts
  on conflict(user_id,alert_id) do update set status='new',selected_rxcui=null,saved_at=null;
end $$;
revoke all on function public.select_demo_alternative(text,text), public.reset_demo_reviews() from public, anon;
grant execute on function public.select_demo_alternative(text,text), public.reset_demo_reviews() to authenticated;

-- Atomic reservation prevents concurrent servers from sending the same notification twice.
create function public.reserve_demo_notification(p_id text,p_result jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare previous jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  insert into public.demo_notification_receipts(user_id,id,result) values(auth.uid(),p_id,p_result)
    on conflict(user_id,id) do nothing;
  if found then return null; end if;
  select result into previous from public.demo_notification_receipts where user_id=auth.uid() and id=p_id;
  return previous;
end $$;
revoke all on function public.reserve_demo_notification(text,jsonb) from public, anon;
grant execute on function public.reserve_demo_notification(text,jsonb) to authenticated;
