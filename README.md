# How many patients have I financially ruined?

Medicare Part D coverage and cost estimates for doctors. Coverage decisions come from CMS formulary data and deterministic code — never from an LLM.

## Demo (current)

One drug: **NovoLog FlexPen** (insulin aspart, RXCUI `1653204`). Five synthetic Georgia patients. Three lost coverage between CMS quarterly `v1` and monthly `v2-cms` on Kaiser `H1170-002`; two still covered on Humana Basic Rx.

## Run locally

```bash
# Needs data/scenario.duckdb (gitignored). Copy from the api worktree or rebuild:
#   python loaders + npx tsx scripts/seed-scenario.ts
#   npx tsx scripts/run-pipeline.ts 1653204

npm install
npm run dev          # http://localhost:3000
npm test
npx tsc --noEmit
```

Optional: `RUINED_DB=/path/to/file.duckdb` overrides the default `data/scenario.duckdb`.

`npm test` copies the database into a temp file for real-data suites, so it can run while `next
dev` is open. Stop the server before any script that *writes* the database (seed, pipeline, loaders).

## App routes

| Path | What it does |
|------|----------------|
| `/` | Alert inbox for `doc-001` |
| `/dashboard` | Counts + chart for the same alerts |
| `/check` | Search a patient / prescription, then live coverage check |

## API

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/doctors/:id/alerts` | `PatientAlert[]` |
| POST | `/api/check` | `{ coverage, alternatives }` |
| GET | `/api/patients/search?q=` | `PatientSummary[]` |
| GET | `/api/drugs/search?patientId=&q=` | `DrugOption[]` |
| POST | `/api/alerts/:id/dismiss` | `PatientAlert` |
| POST | `/api/demo/reset` | `{ reset: true }` (reopens coverage alerts and resets patient alerts) |
| GET | `/api/alerts` | `CoverageAlert[]` |
| GET | `/api/alerts/:id` | `CoverageAlert`, 404 if unknown |
| POST | `/api/alerts/:id/resolve` | `CoverageAlert` (idempotent), 404 if unknown |

Shared types live in `lib/contract.ts`. Schema: `data/schema.sql` / `DATA_MODEL.md`. Build notes: `PROGRESS.md`.

## Coverage Watchdog alerts (Eliquis + Humana)

Change-level alerts: "this Humana plan changed this rule for Eliquis." No patient data. Type:
`CoverageAlert` in `lib/contract.ts`. Errors are `{ error }` with 400 / 404 / 500.

The data is **demo data** for now (`lib/demoCoverageAlerts.ts`, every alert has `isDemo: true`).
Resolved state is kept in server memory, so a restart reopens every alert.

**Swapping in the real pipeline** (`lib/coverageAlerts.ts`): a data source only returns
`CoverageChangeInput[]` (id, insurer, planId, planName, drug, rxcui, changeType, oldValue,
newValue, effectiveDate, detectedAt, source, sourceUrl). The service translates pipeline change
names (`new_prior_auth` -> `prior_auth_added`, `removed` -> `dropped`), writes the summary and
action steps, and tracks open/resolved. Add the loader to `coverageAlertStore()` and set
`COVERAGE_ALERTS_SOURCE`. Routes and frontend do not change.

## Aggregate pipeline

Reproducible CMS bootstrap and the isolated Eliquis aggregate pipeline (milestones
01-08): [source and ingestion guide](docs/pipeline-milestones.md) and
[offline demo, daily runner, cross-check, and console outbox](docs/pipeline-operations.md).

Run the offline real-baseline proof with `npm run pipeline:e2e` (no network or
preexisting database required).
