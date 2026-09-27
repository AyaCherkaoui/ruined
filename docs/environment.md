# HeadsUp environment and deployment

The working local settings are in ignored `.env.local`. Git push does not copy these to a host. Transfer values directly into the deployment's environment-variable settings; do not paste tokens into chat, commit them, or give Twilio secrets a `NEXT_PUBLIC_` prefix.

## Hosted app settings

| Variable | Value/source |
| --- | --- |
| `APP_URL` | `https://headsuphealth.tech` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://aubtnsvksswxpghmamuu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Copy the matching publishable key from `.env.local` or this Supabase project's API settings |
| `COVERAGE_ALERTS_SOURCE` | `supabase` (also the default when Supabase is configured) |
| `PATIENT_DATA_SOURCE` | `supabase` (default with Supabase configured); `local` explicitly selects DuckDB |
| `MESSAGING_CHANNEL` | `whatsapp` |
| `SMS_MODE` | `live` for the demo; `preview` to prevent sending |
| `TWILIO_ACCOUNT_SID` | Copy the working value from `.env.local` |
| `TWILIO_AUTH_TOKEN` | Copy the working value from `.env.local`; server-only |
| `TWILIO_WHATSAPP_FROM` | Copy the working Sandbox sender from `.env.local` |
| `DOCTOR_PHONE` | Copy the configured demo recipient from `.env.local` |
| `SMS_SEND_TOKEN` | Copy the existing messaging access key from `.env.local`; enter this key in the app to send/check delivery |
| `RUINED_DB` | Only needed for `PATIENT_DATA_SOURCE=local` or offline CMS ingestion scripts |

Do not set `NEXT_VERIFY_BUILD` on the host; it is a local verification-build switch. `TWILIO_FROM_NUMBER` is not required for WhatsApp. `SUPABASE_SERVICE_ROLE_KEY`, a Supabase secret key, and `DATABASE_URL` are not required by the current app. In particular, setting `DATABASE_URL` does **not** switch the patient database to Postgres. Leave `COVERAGE_ALERTS_PAYLOAD` and `COVERAGE_ALERTS_NPI` unset unless deliberately using the separate aggregate pipeline.

The `NEXT_PUBLIC_` Supabase values must be set before `npm run build`; redeploy after changing them. Set variables for the production environment serving the custom domain, not just development or preview. Runtime/server values must also be available to the running process.

## Coolify deployment on Vultr

`headsuphealth.tech` runs in Docker containers built by Coolify from
`AyaCherkaoui/ruined`, branch `main`. Deploy through GitHub and Coolify; server file
edits are not durable. SSH, a server-side Git checkout, PM2, and systemd are not part
of this deployment workflow.

Push reviewed changes to `main`. Rafay reviews the push, applies any outstanding
Supabase migrations, checks Coolify environment variables, and selects Redeploy.
The two hosted-demo migrations in this change have already been applied to
`aubtnsvksswxpghmamuu`, and the verified seed is already uploaded. Do not execute
those migrations again manually in that project. No new environment variables are
required; the existing Supabase URL and publishable key select the hosted patient
workflow by default. Leave `PATIENT_DATA_SOURCE` unset or set it to `supabase`.

The `NEXT_PUBLIC_` variables must be available during the Docker build, as well as
at runtime. The hosted patient demo needs no DuckDB upload or persistent database
volume. Keep the current domain, reverse proxy, messaging credentials, and port
configuration. No Coolify settings are changed by editing local `.env.local`.

## Data requirement — environment variables alone are insufficient

Supabase now contains sign-in, profiles, seven verified coverage alerts, and the 136-patient synthetic demo with coverage checks, alternatives, review choices, and notification receipts. See [hosted demo](hosted-demo.md) for the applied migrations, source verification, and reproducible seed commands. The dashboard uses it by default when Supabase is configured. Rebuild and restart the deployed application with this code to activate that change.

The full CMS ingestion and pricing engine remains local for building fresh verified exports. If deliberately selecting `PATIENT_DATA_SOURCE=local`, use one Node process with a writable persistent disk and the populated `scenario.duckdb`. Stop local writes before copying the file. On a fresh local rebuild, follow the CMS bootstrap and drug-cache instructions, then run `npm run demo:seed`.

For local mode only, point `RUINED_DB` to the actual persistent disk location. Do not use a Windows path on a Linux host or an ephemeral `/tmp` copy for durable state.

The hosted demo does not need persistent local storage. Its seven verified plan/drug checks are a fixed snapshot; new drug/plan combinations require another verified export.

## Verify

1. Set the environment variables. The Supabase demo has already been provisioned; use the linked runbook to reproduce it in another project.
2. Run `npm run env:check` on the runtime (after the persistent disk is mounted). It prints validation results without secrets; it does not open the database or contact messaging providers.
3. Build with `npm ci` and `npm run build`, then start with `npm run start` using the host's assigned port.
4. In Supabase Auth URL Configuration, use `https://headsuphealth.tech` as the Site URL. Configure any redirect allowlist entries only for URLs you actually use. Use an existing doctor account; no new auth credentials are created by deployment.
5. Confirm `/login` loads, signed-out `/` redirects to login, and the protected policy endpoint returns 401 when signed out.
6. Sign in, confirm the patient panel appears, and preview the policy-change WhatsApp message. Confirm the preview links to the custom domain.
7. For a live rehearsal, the recipient must have joined the WhatsApp Sandbox and have its custom-message window open. Provider acceptance is not delivery; use **Check delivery**.

The Supabase seed, patient workflow functions, and row-level access have been verified. Deploying the new app code and checking the custom domain require access to the application server.
