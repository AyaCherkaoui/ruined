# Project: "How many patients have I financially ruined?"

Web app for doctors. Checks if a patient's Medicare Part D plan covers a drug, estimates monthly out-of-pocket cost, flags prior auth / step therapy / quantity limits, and suggests cheaper covered alternatives in the same drug class. Dashboard shows patients likely overpaying. Alerts when coverage changes between data versions.

Stack: Next.js + TypeScript, Postgres (Tiger Data via DATABASE_URL), Python + DuckDB for data processing, RxNav API for drug normalization.

Core rule: every coverage decision comes from our data and deterministic logic. Never from an LLM.

## Your job tonight: BACKEND ONLY
Work only in /data, /scripts, /lib, and /app/api. Do not build UI pages.
Match the types in /lib/contract.ts exactly.

## Rules
- Work on the `backend` branch only. Commit locally. Do NOT push (no remote yet).
- Do not stop to ask questions. Make reasonable assumptions and log them in PROGRESS.md.
- Commit after every finished task with a clear message.
- Update PROGRESS.md after each task: what's done, what's broken, assumptions.
- If DATABASE_URL is missing or fails, use a local DuckDB file with the same schema so it can be pointed at Postgres later.
- If a task is blocked for more than 30 minutes, log it and move on.
- Add .env and raw data files to .gitignore. Never commit large data files.

## Tasks (in order)
1. Find and download the latest QUARTERLY CMS Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information public use file from https://www.cms.gov/research-statistics-data-systems/prescription-drug-plan-formulary-pharmacy-network-and-pricing-information-files . Read the record layout PDF inside it.
2. Python + DuckDB script: filter to Georgia plans only. Load tables: plans, formulary, beneficiary_cost, pricing. Add data_version = 'v1'. Index join keys.
3. Drug normalizer in TypeScript: drug name to RXCUI using RxNav API, drug class using RxClass. Cache in a drugs table.
4. checkCoverage(contractId, planId, segmentId, rxcui): covered, tier, PA/ST/QL flags, estimated 30-day out-of-pocket cost using beneficiary cost rules for the tier applied to pricing unit cost. Ignore deductibles and coverage phases for now. Label as estimate. Write tests for 5 common drugs.
5. findAlternatives(plan, rxcui): same class, covered by same plan, sort by no restrictions then lowest cost, return top 3. Tests.
6. Seed 20 synthetic patients assigned to real Georgia plans, 2 to 4 common meds each. Make 5 to 7 of them on expensive drugs.
7. API routes: GET /api/patients, GET /api/patients/[id], POST /api/check, GET /api/dashboard.
8. Change tracker: create a v2 formulary copy where a few drugs our seed patients use move to a higher tier. Diff v1 vs v2, match affected patients. GET /api/alerts.
