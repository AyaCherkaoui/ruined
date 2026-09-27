create function public.dismiss_demo_alert(p_alert_id text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  insert into public.demo_patient_reviews(user_id,alert_id,status) values(auth.uid(),p_alert_id,'dismissed')
  on conflict(user_id,alert_id) do update set status='dismissed';
end $$;
revoke all on function public.dismiss_demo_alert(text) from public, anon;
grant execute on function public.dismiss_demo_alert(text) to authenticated;
