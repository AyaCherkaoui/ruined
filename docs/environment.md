# HeadsUp environment and deployment

The working local settings are in ignored `.env.local`. Git push does not copy these to a host. Transfer values directly into the deployment's environment-variable settings; do not paste tokens into chat, commit them, or give Twilio secrets a `NEXT_PUBLIC_` prefix.

## Hosted app settings

| Variable | Value/source |
| --- | --- |
| `APP_URL` | `https://headsuphealth.tech` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://aubtnsvksswxpghmamuu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Copy the matching publishable key from `.env.local` or this Supabase project's API settings |
| `COVERAGE_ALERTS_SOURCE` | `supabase` (also the default when Supabase is configured) |
| `MESSAGING_CHANNEL` | `whatsapp` |
| `SMS_MODE` | `live` for the demo; `preview` to prevent sending |
| `TWILIO_ACCOUNT_SID` | Copy the working value from `.env.local` |
| `TWILIO_AUTH_TOKEN` | Copy the working value from `.env.local`; server-only |
| `TWILIO_WHATSAPP_FROM` | Copy the working Sandbox sender from `.env.local` |
| `DOCTOR_PHONE` | Copy the configured demo recipient from `.env.local` |
| `SMS_SEND_TOKEN` | Copy the existing messaging access key from `.env.local`; enter this key in the app to send/check delivery |
| `RUINED_DB` | Absolute path to the populated `scenario.duckdb` on the host's writable persistent disk |

Do not set `NEXT_VERIFY_BUILD` on the host; it is a local verification-build switch. `TWILIO_FROM_NUMBER` is not required for WhatsApp. `SUPABASE_SERVICE_ROLE_KEY`, a Supabase secret key, and `DATABASE_URL` are not required by the current app. In particular, setting `DATABASE_URL` does **not** switch the patient database to Postgres. Leave `COVERAGE_ALERTS_PAYLOAD` and `COVERAGE_ALERTS_NPI` unset unless deliberately using the separate aggregate pipeline.

The `NEXT_PUBLIC_` Supabase values must be set before `npm run build`; redeploy after changing them. Set variables for the production environment serving the custom domain, not just development or preview. Runtime/server values must also be available to the running process.

## Vultr server

For a Vultr VPS running this repository directly with Node, put the values above in
`.env.local` in the deployed repository root, readable by the account running the app.
Next.js loads that file during both build and startup. Preserve existing values until
the actual service configuration has been inspected: variables already exported by
the process manager override values in the file.

If Docker is used, the Supabase public variables must be supplied during image build,
not only through the container's runtime environment. The patient database needs a
writable persistent volume mounted into the container; `RUINED_DB` must use the path
inside that container. The exact configuration depends on the existing Dockerfile.

For PM2 or systemd, confirm the working directory is the deployed repo and the service
account can write the database and its parent directory (DuckDB creates adjacent WAL
files). Rebuild and restart the existing service after updating settings. Keep one
Node process using the DuckDB file. Don't start a second app process beside the
existing service. Keep the existing reverse proxy and its port configuration.

The server address, SSH username, deployed repo path, and current process manager
must be identified before applying remote changes. No server settings have been
changed merely by updating the local `.env.local`.

## Data requirement — environment variables alone are insufficient

Supabase currently contains sign-in, doctor profiles, and the Coverage Watchdog tables. The patient dashboard, prescriptions, CMS snapshots, review choices, and WhatsApp duplicate-send receipts use DuckDB. The populated local file is `data/scenario.duckdb`, which is intentionally ignored by Git.

The current architecture requires a Node server with a writable persistent disk and one app process accessing that database. Provision the seeded database before starting the app. Stop the source app before copying so the database is closed/checkpointed; don't copy an actively written DuckDB file. Preserve its notification receipts if you want prior sends to remain deduplicated. On a fresh rebuild, follow the CMS bootstrap and drug-cache instructions, then run `npm run demo:seed` before starting the app.

Point `RUINED_DB` to the actual disk location on the host. For example, if a disk is mounted at `/var/data`, use `/var/data/scenario.duckdb`; this example is not an instruction to create a paid disk or assume one exists. Do not use a Windows path on a Linux host or an ephemeral `/tmp` copy for durable demo state.

A host without persistent writable storage needs a database-adapter migration or a different runtime before this full demo will work. Deploying just the repo and adding Supabase variables will not upload the 136 patients.

## Verify

1. Set the environment variables and provision the populated database.
2. Run `npm run env:check` on the runtime (after the persistent disk is mounted). It prints validation results without secrets; it does not open the database or contact messaging providers.
3. Build with `npm ci` and `npm run build`, then start with `npm run start` using the host's assigned port.
4. In Supabase Auth URL Configuration, use `https://headsuphealth.tech` as the Site URL. Configure any redirect allowlist entries only for URLs you actually use. Use an existing doctor account; no new auth credentials are created by deployment.
5. Confirm `/login` loads, signed-out `/` redirects to login, and the protected policy endpoint returns 401 when signed out.
6. Sign in, confirm the patient panel appears, and preview the policy-change WhatsApp message. Confirm the preview links to the custom domain.
7. For a live rehearsal, the recipient must have joined the WhatsApp Sandbox and have its custom-message window open. Provider acceptance is not delivery; use **Check delivery**.

The local Supabase connection and local real WhatsApp delivery have been verified. Hosting settings, hosted database provisioning, and custom-domain availability require separate verification on the actual hosting service.
