-- Coverage Watchdog storage (Eliquis + Humana). Run once in the Supabase SQL Editor.
-- Safe to re-run: every statement is idempotent.
-- No patient data: an alert is a plan-level formulary change, and a resolution is which
-- signed-in doctor marked it handled.

-- ---------------------------------------------------------------------------------
-- coverage_alerts: one row per detected plan change. Shared by every doctor.
-- Written by the pipeline (SQL Editor or a server-side script with the secret key),
-- read-only for signed-in users. Columns match CoverageChangeInput in lib/coverageAlerts.ts.
-- ---------------------------------------------------------------------------------
create table if not exists public.coverage_alerts (
  id                       text primary key,
  insurer                  text not null,
  plan_id                  text not null,
  plan_name                text not null,
  drug                     text not null,
  rxcui                    text,
  change_type              text not null check (change_type in (
                             'prior_auth_added', 'prior_auth_removed',
                             'step_therapy_added', 'step_therapy_removed',
                             'quantity_limit_added', 'quantity_limit_removed',
                             'tier_increase', 'tier_decrease', 'dropped', 'restored')),
  old_value                text,
  new_value                text,
  effective_date           date,
  detected_at              timestamptz not null,
  source                   text not null,
  source_url               text,
  estimated_patients_min   integer,
  estimated_patients_max   integer,
  estimated_patients_basis text,
  is_demo                  boolean not null default false,
  created_at               timestamptz not null default now(),
  constraint coverage_alerts_estimate_complete check (
    (estimated_patients_min is null and estimated_patients_max is null and estimated_patients_basis is null)
    or (estimated_patients_min >= 0 and estimated_patients_max >= estimated_patients_min and estimated_patients_basis is not null)
  )
);

-- ---------------------------------------------------------------------------------
-- coverage_alert_resolutions: per-doctor open/resolved state. A row = resolved by that
-- doctor. No row = open. Each doctor sees and changes only their own rows.
-- ---------------------------------------------------------------------------------
create table if not exists public.coverage_alert_resolutions (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  alert_id    text not null references public.coverage_alerts (id) on delete cascade,
  resolved_at timestamptz not null default now(),
  primary key (user_id, alert_id)
);

-- ---------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------
alter table public.coverage_alerts enable row level security;
alter table public.coverage_alert_resolutions enable row level security;

revoke all on public.coverage_alerts from anon;
revoke all on public.coverage_alert_resolutions from anon;
grant select on public.coverage_alerts to authenticated;
grant select, insert, delete on public.coverage_alert_resolutions to authenticated;

drop policy if exists "Signed-in users read coverage alerts" on public.coverage_alerts;
create policy "Signed-in users read coverage alerts"
  on public.coverage_alerts for select to authenticated
  using (true);

drop policy if exists "Doctors read their own resolutions" on public.coverage_alert_resolutions;
create policy "Doctors read their own resolutions"
  on public.coverage_alert_resolutions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Doctors resolve alerts for themselves" on public.coverage_alert_resolutions;
create policy "Doctors resolve alerts for themselves"
  on public.coverage_alert_resolutions for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Doctors reopen their own resolutions" on public.coverage_alert_resolutions;
create policy "Doctors reopen their own resolutions"
  on public.coverage_alert_resolutions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------------
-- DEMO DATA -- simulated changes, not real. Same rows as lib/demoCoverageAlerts.ts.
-- Delete them once real pipeline rows exist:  delete from public.coverage_alerts where is_demo;
-- ---------------------------------------------------------------------------------
insert into public.coverage_alerts
  (id, insurer, plan_id, plan_name, drug, rxcui, change_type, old_value, new_value,
   effective_date, detected_at, source, source_url, is_demo)
values
  ('demo-eliquis-s5884-135-prior-auth-added', 'Humana', 'S5884-135', 'Humana Basic Rx Plan (PDP)',
   'Eliquis (apixaban) 5 mg tablet', '1364447', 'prior_auth_added',
   'Covered on tier 3 with a quantity limit. No prior authorization.',
   'Covered on tier 3 with a quantity limit. Prior authorization required.',
   '2026-11-01', '2026-09-26T13:00:00Z',
   'DEMO: simulated second snapshot of the Humana formulary (not a real change)', null, true),
  ('demo-eliquis-h5216-073-tier-increase', 'Humana', 'H5216-073', 'HumanaChoice',
   'Eliquis (apixaban) 5 mg tablet', '1364447', 'tier_increase',
   'Tier 3 (preferred brand).', 'Tier 4 (non-preferred drug).',
   '2026-11-01', '2026-09-26T13:00:00Z',
   'DEMO: simulated second snapshot of the Humana formulary (not a real change)', null, true)
on conflict (id) do nothing;
