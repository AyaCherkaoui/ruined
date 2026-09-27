-- Apply after 20260927000000_coverage_alerts.sql. Additive compatibility with the
-- aggregate pipeline: exact numeric QL changes and authoritative source reversals.
begin;
alter table public.coverage_alerts
  add column if not exists source_resolved_at timestamptz;
alter table public.coverage_alerts
  drop constraint if exists coverage_alerts_change_type_check;
alter table public.coverage_alerts
  add constraint coverage_alerts_change_type_check check (change_type in (
    'prior_auth_added', 'prior_auth_removed', 'step_therapy_added', 'step_therapy_removed',
    'quantity_limit_added', 'quantity_limit_removed', 'quantity_limit_tightened', 'quantity_limit_relaxed',
    'tier_increase', 'tier_decrease', 'dropped', 'restored'
  ));
commit;
