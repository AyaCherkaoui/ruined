# Demo backend runbook

The NovoLog patient demo and Eliquis aggregate demo remain separate. SMS transport and
the pulled Supabase authentication flow coexist with both. Saved review choices use the additive
`patient_alert_decisions` table, created automatically on database open or first save.
When Supabase is configured, explicitly select `COVERAGE_ALERTS_SOURCE=aggregate` for
the file-backed Eliquis replay; otherwise Supabase is the default source. Sign-in applies
to either source. See [Supabase setup and migrations](supabase.md).

## NovoLog: run the existing pipeline through the server

Start with the bootstrapped scenario database and cached drug metadata described in
[the bootstrap guide](pipeline-milestones.md). `RUINED_DB` chooses the app database.
Then start the app and use:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/pipeline/run
Invoke-RestMethod http://localhost:3000/api/changes
Invoke-RestMethod http://localhost:3000/api/doctors/doc-001/alerts
```

The run endpoint is fixed to NovoLog RXCUI 1653204 and the staged `v1` / `v2-cms`
releases. It does not download data, accept filesystem paths, ingest new releases, or
send a message. Missing release tables or patient plan mappings fail with 503;
overlapping runs return 409. The baseline must cover NovoLog on every seeded patient's
plan. The entire comparison and matching run reserves one connection and commits or
rolls back together, so failed matching cannot leave partial changes. Other HTTP
requests wait outside the transaction. Retries return the same IDs and preserve reviewed alerts.
It shares the server's database connection, so no separate CLI writer is needed while
the app is open. `GET /api/changes` only reads the stored facts for this scenario.

On `/review/<alertId>`, choosing an alternative calls
`POST /api/alerts/<id>/selection` with `{ "rxcui": "..." }`. The server revalidates
eligibility and pricing against the current plan, saves a separate choice, and marks
the alert `seen` (reviewed). The returned `selectedAlternative` survives reloads and
pipeline reruns. It does not alter the pipeline's recommendation, issue a prescription,
or change the active medication. Reset clears saved decisions, restores status to
`new`, and clears browser selections/notification history after the server succeeds.

The original NovoLog scenario has no eligible alternatives under the existing engine's
rules. To demonstrate the selection action, use the repository's review panel instead.
With the app stopped and the source database closed/checkpointed (no `.wal`), prepare
a separate copy so the five-patient NovoLog scenario remains available:

```powershell
Copy-Item data/scenario.duckdb data/review-demo.duckdb
$env:RUINED_DB = (Resolve-Path data/review-demo.duckdb).Path
npx tsx scripts/run-pipeline.ts 1486977 1486981 1091650 1091654 847910 847915
npx tsx scripts/seed-demo-panel.ts
npm run dev
```

This uses existing CMS removals and the existing 12-patient synthetic review panel.
NovoLog prescriptions move to `doc-archive` in this copy; the run endpoint still
verifies NovoLog, while `doc-001` shows the selectable review panel. No formulary
coverage or interchangeability rules are changed to create a selectable alternative.

## Eliquis: publish pipeline output to Coverage Watchdog

```powershell
npm run demo:prepare
$env:COVERAGE_ALERTS_SOURCE = 'aggregate'
$env:COVERAGE_ALERTS_PAYLOAD = 'data/raw/coverage-alerts.json'
npm run dev
```

Open `/coverage-alerts`, or request `/api/alerts`. The preparation command runs the
existing real-baseline proof in an isolated in-memory database and publishes its
adverse payload by atomic file replacement. It requires neither network access nor
an existing aggregate database. The CMS baseline is real replay data; the PA addition,
reversal, signup and annual claims are explicitly simulated. No external SMS is sent.

While the app runs, these commands replace the payload without restarting it:

```powershell
npm run demo:prepare -- --stage baseline  # zero changes
npm run demo:prepare -- --stage adverse   # one PA-added alert
npm run demo:prepare -- --stage restored  # adverse alert resolved by its inverse
```

Use `POST /api/alerts/<id>/resolve` for manual review and `POST /api/demo/reset` to
clear manual decisions. Reset first validates the selected alert source, then resets
patient status, then clears in-memory coverage review state. It does not replace
the published snapshot or undo a source reversal. To repeat the detection demo,
publish baseline, reset, and publish adverse. The combined reset still requires
the legacy app database to be available.

For actual aggregate pipeline output, export the `eliquis-aggregate-v1` payload with
`pipeline:eliquis payload --db PATH --year 2024 --output PATH` and point
`COVERAGE_ALERTS_PAYLOAD` to that file. When refreshing a running app, export to a
temporary file and atomically rename it over the published path after success. The
loader reads on every request, keeps claims separate from patient counts, and returns
503 on missing or invalid evidence. It never falls back to fake alerts. Plan names
are known for the two watched Humana CMS plans; other identities retain their IDs.

For a doctor-targeted demo, also set `COVERAGE_ALERTS_NPI=0000000000` (the fixture's
synthetic prescriber). This returns only unresolved adverse changes with a matching
`doctorImpacts` entry for that NPI and plan/drug. Missing matches return an empty list;
malformed matching evidence fails closed. Resolved changes leave this active feed.
Omit the variable to show the general feed including reversal history. This server-only
demo setting is not a replacement for authenticated per-user ownership.

## Hosting and rehearsal

Use a Node runtime with DuckDB's native package available, the required local data
files present, and the process working directory set to the repository root. Generated
payloads and databases are gitignored: copy or regenerate them on the demo host.
Use one server process for this demo's in-memory review state. The scheduled CMS
acquisition path remains the separately documented daily command; a scheduler is not
needed for these manual demonstrations.

Run `npm test`, `npx tsc --noEmit`, `npm run lint`, and `npm run build`, then serve with
`npm start`. Rehearse the chosen source three times: detect, read the alert, review,
reset, repeat. Rehearse the configured SMS flow separately on the intended phone;
these commands deliberately do not send SMS or alter SMS deduplication state.

If Windows/OneDrive locks an existing `.next` cache, set `NEXT_VERIFY_BUILD=1` for
both `npm run build` and `npm start` to use the isolated `.next-verify` directory.

No deployment or scheduler is provisioned by these changes. Configure the demo host
and public app URL for the phone rehearsal. Manual review state still resets on a
server restart; source-derived resolution survives because it lives in the payload.

## Verification recorded for this integration

- 210 tests passed; the optional live RxNav test was skipped. The final real-data
  suites used temporary copies of `data/scenario.duckdb`.
- TypeScript and full repository ESLint passed, including the corrected session hook.
- Production build passed using `NEXT_VERIFY_BUILD=1` after OneDrive blocked cleaning
  the existing `.next` cache.
- A local production-server rehearsal completed three cycles through the new HTTP
  routes, with stable three-alert NovoLog results and verified Eliquis source reversals.
  `/`, `/dashboard`, `/coverage-alerts`, and `/check` returned HTTP 200.
- A follow-up production rehearsal using a disposable copy with the 12-patient review
  panel passed save/reload/pipeline-rerun/reset three times. Rendered review HTML showed
  the saved selection, and the configured NPI returned one active Eliquis alert.
- The build still reports an existing dynamic filesystem tracing warning in
  `lib/db.ts:36`. The new payload loader does not add a tracing warning.
- No external SMS, public deployment, or browser interaction rehearsal was performed.
  Browser automation was unavailable; browser storage reset was tested with a mocked
  storage/event surface. Restart an already-running dev server to load the new database
  adapter; the shared handle survives hot reloads.
