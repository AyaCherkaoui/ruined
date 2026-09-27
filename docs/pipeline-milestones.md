# Person 3: aggregate pipeline milestones 01-08

The 2026-09-26 implementation requests authorize milestones 01-08. Milestone 00 and ADR
0001's pending API-owner acknowledgment are unchanged. Aggregate types live in
`lib/pipeline/aggregate-contract.ts`; storage is opt-in through
`data/aggregate-schema.sql`. No shared contract/schema, API route, or UI is changed.

## Condensed roadmap

| Milestone | Deliverable |
|---|---|
| 01 | Catalog-resolved, hashed CMS bootstrap into one database; repeated legacy pipeline verification |
| 02 | Source access evidence, CMS fallback, raw archives, complete two-plan/two-strength observations |
| 03 | Deterministic adverse/reverse facts, completeness gates, reciprocal resolution links |
| 04 | Filtered annual CMS prescriber volume, explicit plan acceptance, labeled aggregate impacts |
| 05 | Implemented: real-baseline plus simulated-change offline demo proof |
| 06 | Implemented: daily orchestration, overlap lock, operational summaries and retention inventory |
| 07 | Implemented: optional aligned normalized CMS/Humana discrepancy reporting |
| 08 | Implemented: optional console-only SMS preview adapter/outbox |

See [milestones 05-08 commands and operational boundaries](pipeline-operations.md).

## Bootstrap the existing app database

Stop processes writing the target database first. From the repository root on Windows:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements.txt
.\.venv\Scripts\python.exe scripts/bootstrap-data.py
```

On POSIX use `.venv/bin/python`. `--db PATH` explicitly selects another database.
If the app holds `scenario.duckdb` open, use `--db data/verified-scenario.duckdb`
and set `RUINED_DB` to that file for verification or the next app startup.
The loader defaults now agree with the app (`RUINED_DB`, otherwise
`data/scenario.duckdb`). The bootstrap resolves actual ZIP filenames from the CMS
catalog, downloads via a `.part` file, computes SHA-256, isolates extraction by
hash, loads `v1` and `v2-cms`, imports the committed drug cache, seeds the existing
NovoLog scenario, and verifies two pipeline runs have identical IDs and counts.
Missing required tables, releases, plans, drugs, or expected alerts fail loudly.

The generated manifest is `data/raw/bootstrap-releases.json`; the legacy pinned
`data/releases.json` is not silently rewritten. Save a catalog response and pass
`--catalog PATH` to reproduce a selected release instead of choosing the latest.
Existing ZIPs are hashed again on every run. This rebuild writes the selected
version partitions; use a separate `--db` when preserving a customized baseline.

## Source decision: CMS fallback

Official discovery: [Humana catalog](https://developers.humana.com/public-catalog),
[Humana-owned Medication documentation](https://developer.careplushealthplans.com/apis/medication-api/doc),
and [live capability statement](https://fhir.humana.com/api/metadata).

The access spike reached FHIR R4 4.0.1 at `https://fhir.humana.com/api/` without a
token: metadata and `List?_count=1` returned HTTP 200. The capability statement
advertises OAuth; public reads succeeding does not prove every endpoint is
tokenless. Both watched RXCUI searches on `MedicationKnowledge?code=...` returned
HTTP 200 with zero results; an unfiltered MedicationKnowledge request timed out.
The List bundle uses `link` pagination and contains MedicationKnowledge references.
No published rate limit was established. Short CMS plan identifier searches
returned no rows; year-qualified identifiers `S5884-135-000-2026` and
`S5884-156-000-2026` returned totals of 34 and 35 List matches respectively.
A unique plan-to-Eliquis mapping was therefore not proven:
**the production acquisition path in this pass is CMS**, as required
by ADR 0001's failed-spike fallback. No speculative FHIR parser is shipped.
Local request evidence is in ignored `data/raw/humana-*.json`.

Selected CMS identities are Humana Basic Rx `S5884-135-000` and Humana Premier Rx
`S5884-156-000`. The export verifies their Humana names and nonempty formularies
in the chosen release; it never treats an absent plan as noncoverage.

```powershell
npm run pipeline:eliquis -- export-cms --source-db data/scenario.duckdb --release v2-cms --plans data/fixtures/eliquis/humana-cms-plans.json --captured-at 2026-09-27T00:00:00.000Z --output data/raw/eliquis-cms.json
npm run pipeline:eliquis -- ingest --input data/raw/eliquis-cms.json --run cms-september
```

The default aggregate DB is `data/eliquis.duckdb`; override with `--db PATH` on
every command. CMS is a release source, **not daily Humana observations**. Exported
local data is labeled `replay`. An exported snapshot links to its ZIP hash;
normalized observations link to the archived snapshot's SHA-256. No unverified
source is relabeled `live`. A release publication date is not a coverage
effective date; the latter remains null unless explicitly present in an input.

Four explicit observations are required (two plans times RXCUIs `1364447` and
`1364441`). All NDC rows remain in the archived source. Identical restrictions
collapse to one RXCUI observation with `ndc: null`; conflicting NDC restrictions
are quarantined instead of arbitrarily selecting a tier. Missing entries fail
completeness; only an explicit empty drug row list from a validated formulary
represents noncoverage. Failed runs retain valid observations and quarantine
reasons but cannot participate in comparisons. Same-id different-content replay
fails; use a new run id after correcting a failed input.

## Offline lifecycle and impact commands

These fixtures are wholly synthetic and labeled accordingly. They verify 02-04;
they are not milestone 05's real-baseline demo.

```powershell
npm run pipeline:eliquis -- ingest --input data/fixtures/eliquis/baseline.json --run baseline
npm run pipeline:eliquis -- ingest --input data/fixtures/eliquis/adverse.json --run adverse
npm run pipeline:eliquis -- compare --from baseline --to adverse
npm run pipeline:eliquis -- load-prescribers --input data/fixtures/eliquis/prescribers.jsonl --year 2024 --source-id synthetic-unit-fixture --provenance simulated
npm run pipeline:eliquis -- accept-plans --input data/fixtures/eliquis/acceptance.json
npm run pipeline:eliquis -- payload --year 2024 --output data/raw/eliquis-payload.json
npm run pipeline:eliquis -- ingest --input data/fixtures/eliquis/restored.json --run restored
npm run pipeline:eliquis -- compare --from adverse --to restored
npm run pipeline:eliquis -- impact --year 2024
```

Before reversal there is one PA-added fact and one claims-volume impact. After
reversal the PA-removed fact links both ways and the active impact list is empty.
Historical impacts remain stored; consumers should use the returned active list
and source facts, not read all stored historical impacts as current alerts.
Rerunning a pair returns existing facts, including later resolution links.

Comparisons require equal scope, the same source, and increasing capture times.
One database holds one chronological comparison chain. Branches require a
separate database; production multi-watch scheduling belongs to milestone 06.
Known tier/PA/ST/QL changes produce separate facts. Unknown values produce none.
Coverage transitions suppress incidental field changes; numeric QL changes
compare amount per day. Improvements resolve the most recent open inverse type,
as specified in ADR 0001; they do not assert that every earlier change is undone.

## CMS prescriber source and interpretation

[Dataset](https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/medicare-part-d-prescribers-by-provider-and-drug),
[2024 machine-readable dictionary](https://data.cms.gov/data-api/v1/dataset/9552739e-3d05-4c1b-8eff-ecabf391e2e5/dictionary),
and [API documentation](https://data.cms.gov/api-docs) were checked for this pass.
`Tot_Clms` counts original prescriptions plus refills; records with fewer than 11
claims are omitted. `Tot_Benes` is a distinct field with blank suppressed values;
it is not used to fabricate a claims-derived patient count.

```powershell
npm run pipeline:eliquis -- load-prescribers --dataset 9552739e-3d05-4c1b-8eff-ecabf391e2e5 --year 2024 --db data/eliquis-live.duckdb
```

The loader requests Georgia/apixaban filters, paginates by size/offset, archives
raw responses and safe metadata, retries 429/5xx with bounded delays, and fails
immediately on permanent HTTP errors. Offline JSONL is streamed and locally
filtered as well. Annual rows are keyed by year/NPI/normalized ingredient.
Identical rows do not sum twice; conflicting annual duplicates roll back the
load for explicit reconciliation. Suppression markers and missing values remain
null and are distinguished. A missing value uses an unknown derived range
(both bounds null), never an invented zero.

Signup acceptance is explicitly `demo_signup`; CMS data does not establish plan
acceptance. Returned `total_claims` volume spans all plans and ingredient
strengths. It is a relevance estimate, not Humana enrollment, uniquely affected
beneficiaries, or strength-specific prescribing; do not sum it across strengths
or change facts. Source row hash, dataset id, field, year, and provenance remain
on the stored volume record.

The isolated contract adds four quality flags to the proposed ADR enum:
`missing_source_value`, `ingredient_level_volume`, `not_plan_specific`, and
`simulated_source`. These are part of the pending API handoff, not changes to
the existing application contract. No patient/prescription/enrollment records
are inserted by the aggregate pipeline.

## Verification

```powershell
npm test
npx tsc --noEmit
npm run lint
```

New tests cover deterministic replay, quarantine/completeness, all reverse
classifications, reciprocal links, simultaneous changes, unknown restrictions,
QL rates, source pagination/retries, annual conflicts, suppression, plan
acceptance, and active-impact resolution. Live requests are opt-in CLI actions;
the test suite needs no network.

### Verified execution (2026-09-26 local / September 27 UTC)

- Python 3.14 installed DuckDB 1.5.5 successfully in the local virtual environment.
- The app held `scenario.duckdb` open during setup; the complete verified rebuild
  is `data/verified-scenario.duckdb`. Set `$env:RUINED_DB = (Resolve-Path
  data/verified-scenario.duckdb).Path` before running the app or real-data tests.
- Both releases contain 152 plans; formulary rows are 111,958 / 112,513;
  beneficiary-cost rows are 4,783 per release; pricing rows are 1,061,320 per
  release (monthly pricing is explicitly inherited from the quarterly release).
- The legacy pipeline produced three changes and three alerts on both passes.
- Real CMS export/import completed with four observations, both selected plans,
  both strengths, and zero quarantined rows. Output is
  `data/raw/eliquis-cms-result.json`; aggregate database is `data/eliquis-live.duckdb`.
- Public CMS prescriber import loaded 7,367 rows; repeat import loaded zero.
- Synthetic CLI runs produced identical logical payloads twice, then a reciprocal
  reversal with no active impacts. Output: `data/raw/eliquis-verified-payload.json`.
- Full suite against the verified database: **134 passed, 1 skipped** (opt-in
  live RxNav); TypeScript and lint passed. All previously missing-database suites ran.

The generated databases, outputs, downloads, and source evidence are local and
gitignored. The later 05-08 implementation adds a redacted real-baseline fixture,
offline proof, daily command, discrepancy report, and console outbox. It does not
deploy a scheduler, expose a new API, or send an external message.
