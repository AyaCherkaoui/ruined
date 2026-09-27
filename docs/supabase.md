# Supabase: database and sign-in

## HeadsUp project

Use project reference `aubtnsvksswxpghmamuu`:
`https://aubtnsvksswxpghmamuu.supabase.co`.
Set `NEXT_PUBLIC_SUPABASE_URL` to that URL and obtain its publishable key from
the same project's settings for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
Keep the key in environment configuration. Set these in both `.env.local` and
the hosting environment, then rebuild; local configuration does not update deployment settings.

The connected project's tables, constraints, row-level policies, and profile-update trigger
were verified against all three repository SQL migrations. Its migration-history list is
empty, so schema compatibility was checked directly rather than inferred from migration IDs.

Supabase is optional. With `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
in `.env.local`:

- every page needs a signed-in doctor (email + password), and `/login` is the only open page
- `/api/alerts`, `/api/alerts/:id`, `/api/alerts/:id/resolve`, `/api/demo/reset`,
  `/api/pipeline/run`, `/api/changes`, and `/api/alerts/:id/selection` return
  `401 {"error":"Sign in required"}` when signed out
- coverage alerts come from Supabase Postgres, and each doctor has their own open/resolved state

Without those variables the app runs as before: no sign-in, in-memory demo alerts. Response
shapes are the same either way (`CoverageAlert` in `lib/contract.ts`).

`COVERAGE_ALERTS_SOURCE` explicitly selects `supabase`, `demo`, or `aggregate`.
With Supabase configured the default is `supabase`; otherwise it is `demo`. The
`aggregate` option reads the published pipeline payload described in the demo runbook.
All three sources still require sign-in when Supabase is configured.

Only the publishable key is used. No service-role or secret key is needed by the app.

## Setup (once per project)

1. SQL Editor: run `supabase/migrations/20260927000000_coverage_alerts.sql`, then
   `supabase/migrations/20260927010000_aggregate_alert_compatibility.sql` to support
   numeric quantity-limit changes and source-driven resolutions. Existing installations
   need only the second migration. Repository edits do not apply migrations to a live project.
2. Authentication > Sign In / Providers: Email enabled. Turn **off** "Allow new users to sign up"
   (there is no sign-up page, and the publishable key is public).
3. Authentication > URL Configuration: Site URL = your app URL (`http://localhost:3000` locally).
4. Authentication > Users > Add user > Create new user: email, password, **Auto Confirm User** on.

## Tables

| Table | Who writes | Who reads |
|---|---|---|
| `coverage_alerts` | the pipeline (SQL Editor or a server-side script) | signed-in users |
| `coverage_alert_resolutions` | each signed-in doctor, own rows only | each doctor, own rows only |

A resolution row means "this doctor resolved this alert". No row means open. Demo reset deletes
the signed-in doctor's own rows. No patient data is stored in Supabase; the synthetic
patient demo and its saved decisions remain in local DuckDB. Source-driven resolutions
are stored on the change itself and are not undone by a doctor's reset.

## Inserting real coverage changes (Person 3)

One `coverage_alerts` row per detected change. Columns match `CoverageChangeInput` in
`lib/coverageAlerts.ts`:

| column | required | example |
|---|---|---|
| `id` | yes, stable across reruns | a hash of plan + rxcui + change type + snapshot |
| `insurer` | yes | `Humana` |
| `plan_id` | yes | `S5884-135` |
| `plan_name` | yes | `Humana Basic Rx Plan (PDP)` |
| `drug` | yes | `Eliquis (apixaban) 5 mg tablet` |
| `rxcui` | no | `1364447` |
| `change_type` | yes, one of the 12 API names | `prior_auth_added` |
| `old_value`, `new_value` | no | `Tier 3. No prior authorization.` |
| `effective_date` | no | `2026-11-01` |
| `detected_at` | yes | `2026-09-26T13:00:00Z` |
| `source` | yes | `Humana formulary API, snapshot 2026-09-26` |
| `source_url` | no | |
| `estimated_patients_min`, `_max`, `_basis` | no, all three or none | `8`, `12`, `CMS Part D prescriber data` |
| `is_demo` | no, default false | |
| `source_resolved_at` | no, set by a source reversal | `2026-09-29T00:00:00Z` |

`change_type` accepts only `prior_auth_added`, `prior_auth_removed`, `step_therapy_added`,
`step_therapy_removed`, `quantity_limit_added`, `quantity_limit_removed`, `tier_increase`,
`tier_decrease`, `dropped`, `restored`, `quantity_limit_tightened`, `quantity_limit_relaxed`. From TypeScript, `changeInputToRow()` in
`lib/supabaseCoverageAlerts.ts` translates pipeline names (`new_prior_auth`,
`prior_authorization_added`, `coverage_removed`, ...) and preserves source resolution timestamps.

Signed-in users cannot write `coverage_alerts`, so inserts come from:

- **SQL Editor** (quickest):
  ```sql
  insert into public.coverage_alerts
    (id, insurer, plan_id, plan_name, drug, rxcui, change_type, old_value, new_value,
     effective_date, detected_at, source, source_url)
  values ('<stable id>', 'Humana', 'S5884-135', 'Humana Basic Rx Plan (PDP)',
          'Eliquis (apixaban) 5 mg tablet', '1364447', 'prior_auth_added',
          'Tier 3. No prior authorization.', 'Tier 3. Prior authorization required.',
          '2026-11-01', now(), 'Humana formulary API', null)
  on conflict (id) do nothing;
  ```
- **A pipeline script** run on a trusted machine, with the project's secret key in a
  non-`NEXT_PUBLIC_` variable (e.g. `SUPABASE_SECRET_KEY`) that never reaches the app or browser:
  `createClient(url, secretKey).from("coverage_alerts").upsert(inputs.map(changeInputToRow), { onConflict: "id", ignoreDuplicates: true })`.

Once real rows exist, remove the demo ones: `delete from public.coverage_alerts where is_demo;`

## Doctor profiles

`doctor_profiles`: one row per Supabase Auth user (`name`, `npi`, `specialty`, `organization`,
`phone`, timestamps). No passwords (Supabase Auth keeps those), no patient data.

- Setup: run `supabase/migrations/20260927020000_doctor_profiles.sql` after the two above.
- A signed-in doctor can read and update only their own row (name, npi, specialty,
  organization, phone). Doctors cannot create or delete profiles: add them in the SQL Editor.
- Test account: run `supabase/seed-test-doctor-profile.sql` to give `doctor@test.com` a fake
  profile. It finds the user by email; no UUID is hardcoded.
- Server code: `getCurrentDoctorProfile()` in `lib/doctorProfile.ts` returns the signed-in
  doctor's profile, `null` when there is none (or Supabase is off), and a 401 when signed out.
- The header shows the signed-in doctor's profile name and NPI, and falls back to the demo doctor
  when there is no profile.

