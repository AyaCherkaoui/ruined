-- FAKE test data for the doctor@test.com demo account. Not a migration: run by hand in the
-- Supabase SQL Editor after 20260927020000_doctor_profiles.sql. Safe to re-run.
-- Looks the user up by email, so no auth UUID is hardcoded. Inserts nothing if the account
-- does not exist.
-- The NPI 0000000000 cannot belong to a real doctor (real NPIs start with 1 or 2 and pass a
-- check digit). 555-01xx is a reserved fictional phone range.

insert into public.doctor_profiles (user_id, name, npi, specialty, organization, phone)
select id, 'Dr. Test Doctor', '0000000000', 'Cardiology', 'Demo Cardiology Clinic (test)', '+1 404-555-0100'
from auth.users
where email = 'doctor@test.com'
on conflict (user_id) do update
  set name = excluded.name,
      npi = excluded.npi,
      specialty = excluded.specialty,
      organization = excluded.organization,
      phone = excluded.phone;

-- Check: should return exactly one row.
select p.name, p.npi, p.specialty, p.organization, p.phone, p.created_at, p.updated_at
from public.doctor_profiles p
join auth.users u on u.id = p.user_id
where u.email = 'doctor@test.com';
