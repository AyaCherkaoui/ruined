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
| POST | `/api/demo/reset` | `{ reset: true }` |

Shared types live in `lib/contract.ts`. Schema: `data/schema.sql` / `DATA_MODEL.md`. Build notes: `PROGRESS.md`.
