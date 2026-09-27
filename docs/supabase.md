# Supabase: database and sign-in

Supabase is optional. With `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
in `.env.local`:

- every page needs a signed-in doctor (email + password), and `/login` is the only open page
- `/api/alerts`, `/api/alerts/:id`, `/api/alerts/:id/resolve` and `/api/demo/reset` return
  `401 {"error":"Sign in required"}` when signed out
- coverage alerts come from Supabase Postgres, and each doctor has their own open/resolved state

Without those variables the app runs as before: no sign-in, in-memory demo alerts. Response
shapes are the same either way (`CoverageAlert` in `lib/contract.ts`).

Only the publishable key is used. No service-role or secret key is needed by the app.

## Setup (once per project)

1. SQL Editor: run `supabase/migrations/20260927000000_coverage_alerts.sql`.
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
the signed-in doctor's own rows. No patient data is stored anywhere.

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
| `change_type` | yes, one of the 10 API names | `prior_auth_added` |
| `old_value`, `new_value` | no | `Tier 3. No prior authorization.` |
| `effective_date` | no | `2026-11-01` |
| `detected_at` | yes | `2026-09-26T13:00:00Z` |
| `source` | yes | `Humana formulary API, snapshot 2026-09-26` |
| `source_url` | no | |
| `estimated_patients_min`, `_max`, `_basis` | no, all three or none | `8`, `12`, `CMS Part D prescriber data` |
| `is_demo` | no, default false | |

`change_type` accepts only `prior_auth_added`, `prior_auth_removed`, `step_therapy_added`,
`step_therapy_removed`, `quantity_limit_added`, `quantity_limit_removed`, `tier_increase`,
`tier_decrease`, `dropped`, `restored`. From TypeScript, `changeInputToRow()` in
`lib/supabaseCoverageAlerts.ts` translates pipeline names (`new_prior_auth`,
`prior_authorization_added`, `coverage_removed`, ...) and rejects ones the API cannot show
(`quantity_limit_tightened` / `_relaxed`).

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
