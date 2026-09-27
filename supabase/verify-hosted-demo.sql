-- Transactional smoke test. All review/receipt mutations are rolled back.
begin;
select set_config('request.jwt.claim.sub',(select user_id::text from public.doctor_profiles limit 1),true);
set local role authenticated;
do $$
declare v_alert_id text; choice text; first_saved timestamptz; rejected boolean := false;
begin
  if auth.uid() is null then raise exception 'A demo auth user is required for this test'; end if;
  if (select count(*) from public.demo_patients) <> 136 then raise exception 'Patient count mismatch'; end if;
  select a.id,c.result->'alternatives'->0->>'rxcui' into v_alert_id,choice
  from public.demo_patient_alerts a join public.demo_coverage_checks c on c.id=a.check_id order by a.id limit 1;
  perform public.select_demo_alternative(v_alert_id,choice);
  select saved_at into first_saved from public.demo_patient_reviews r where r.alert_id=v_alert_id and r.user_id=auth.uid();
  perform public.select_demo_alternative(v_alert_id,choice);
  if not exists(select 1 from public.demo_patient_reviews r where r.alert_id=v_alert_id and r.selected_rxcui=choice and r.saved_at=first_saved and r.status='seen') then
    raise exception 'Selection did not persist idempotently'; end if;
  perform public.dismiss_demo_alert(v_alert_id);
  if not exists(select 1 from public.demo_patient_reviews r where r.alert_id=v_alert_id and r.selected_rxcui=choice and r.status='dismissed') then
    raise exception 'Dismiss lost selection'; end if;
  begin perform public.select_demo_alternative(v_alert_id,'not-a-covered-drug');
  exception when check_violation then rejected := true; end;
  if not rejected then raise exception 'Invalid alternative was accepted'; end if;
  if public.reserve_demo_notification('hosted-verification-only','{"status":"unknown"}'::jsonb) is not null then raise exception 'First reservation failed'; end if;
  if public.reserve_demo_notification('hosted-verification-only','{"status":"unknown"}'::jsonb)->>'status' <> 'unknown' then raise exception 'Duplicate reservation failed'; end if;
  perform public.reset_demo_reviews();
  if (select count(*) from public.demo_patient_reviews where status='new' and selected_rxcui is null)<>136 then raise exception 'Reset failed'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
  if exists(select 1 from public.demo_patient_reviews) or exists(select 1 from public.demo_notification_receipts) then raise exception 'RLS leaked another user data'; end if;
end $$;
reset role;
select jsonb_build_object('patients', (select count(*) from public.demo_patients),
  'authenticated_workflow','passed','cross_user_isolation','passed',
  'anonymous_table_access',has_table_privilege('anon','public.demo_patients','select'),
  'anonymous_mutation_access',has_function_privilege('anon','public.select_demo_alternative(text,text)','execute')) as verification;
rollback;
