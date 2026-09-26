# Data model (api branch, minimal-patient pivot)

Sponsor direction (Impiricus): minimal patient data, and prove the pipeline end to end with
**one** drug before adding others. This replaces the `backend`/`frontend` branches' 20-patient
dashboard model (age, language, embedded meds) with a normalized, versioned model built around
one real coverage change.

A patient is an **id and a name. Nothing else about the patient, ever.** Everything else
(who prescribed what, what plan they're on, what changed, what it costs) lives in its own table
and points back to the patient by id.

## Tables

### `doctors`
| column | type | |
|---|---|---|
| id | VARCHAR PK | |
| full_name | VARCHAR | |
| phone | VARCHAR | nullable |

### `patients`
| column | type | |
|---|---|---|
| id | VARCHAR PK | |
| full_name | VARCHAR | the only fact about the patient stored here |

### `patient_coverage`
The patient's current Part D plan enrollment. One row per patient (current coverage only --
no history, no `data_version`): which plan a patient is enrolled in doesn't change when a new
formulary release is loaded, only what that plan's formulary says.

| column | type | |
|---|---|---|
| patient_id | VARCHAR PK | |
| contract_id | VARCHAR | + plan_id + segment_id = the plan key used everywhere else (`lib/coverage.ts`'s `PlanKey`) |
| plan_id | VARCHAR | |
| segment_id | VARCHAR | |

### `prescriptions`
| column | type | |
|---|---|---|
| id | VARCHAR PK | |
| patient_id | VARCHAR | -> patients.id |
| doctor_id | VARCHAR | -> doctors.id |
| rxcui | VARCHAR | -> drugs.rxcui |
| started_at | TIMESTAMP | |

### `data_versions`
One row per loaded CMS release. `id` is the label already used as the `data_version` column
on `plans` / `formulary` / `beneficiary_cost` / `pricing` (unchanged from the `backend` branch --
e.g. `'v1'`, `'v2-cms'`), so this table is metadata *about* those rows, not a new join key they
need to adopt.

| column | type | |
|---|---|---|
| id | VARCHAR PK | matches `plans.data_version` etc. |
| source | VARCHAR | human-readable description of the release |
| release_date | DATE | CMS's release/period-start date, nullable |
| file_hash | VARCHAR | sha256 of the source zip; the idempotency key for `ingestRelease` |
| loaded_at | TIMESTAMP | when we loaded it |

### `coverage_changes`
Every **adverse** formulary change detected between two loaded versions, for one
`(formulary_id, rxcui)` pair: dropped from the formulary, moved to a higher tier, or newly
requires prior auth / step therapy / a quantity limit. Improvements are not recorded here --
this table is "what a doctor needs to know changed for the worse," not a full diff.

A drug that changes in more than one way at once (e.g. tier increase *and* new PA) gets one row
**per `change_type`**, not one row with an arbitrarily chosen "primary" type.

| column | type | |
|---|---|---|
| id | VARCHAR PK | |
| from_version | VARCHAR | -> data_versions.id |
| to_version | VARCHAR | -> data_versions.id |
| formulary_id | VARCHAR | |
| rxcui | VARCHAR | |
| change_type | VARCHAR | `removed` \| `tier_increase` \| `new_prior_auth` \| `new_step_therapy` \| `new_quantity_limit` |
| old_tier, new_tier | INTEGER | nullable (`removed` has no new_tier) |
| old_pa, new_pa | BOOLEAN | |
| old_st, new_st | BOOLEAN | |
| old_ql, new_ql | BOOLEAN | |
| detected_at | TIMESTAMP | |

### `patient_alerts`
One row per `(coverage_change, prescription)` pair the change actually hits: the patient's
`patient_coverage` plan uses the affected `formulary_id`. Costs and the suggested switch are
never recomputed ad hoc here -- they come straight from `checkCoverage` / `findAlternatives`
(the existing, tested deterministic logic).

| column | type | |
|---|---|---|
| id | VARCHAR PK | |
| change_id | VARCHAR | -> coverage_changes.id |
| patient_id | VARCHAR | -> patients.id |
| prescription_id | VARCHAR | -> prescriptions.id |
| contract_id, plan_id | VARCHAR | the patient's plan at the time of the alert |
| old_monthly_cost, new_monthly_cost | DOUBLE | from `checkCoverage` at `from_version` / `to_version` |
| best_alternative_rxcui, best_alternative_cost | VARCHAR / DOUBLE | top result of `findAlternatives` at `to_version`, or null if none |
| status | VARCHAR | `new` \| `seen` \| `switched` \| `dismissed`. No endpoint writes anything but `new` yet (see PROGRESS.md) |
| created_at | TIMESTAMP | |

## Unchanged from `backend`/`frontend`
`plans`, `formulary`, `beneficiary_cost`, `pricing`, `drugs`, `drug_aliases` are the same tables,
same columns, same `data_version`-per-row convention -- the CMS-derived side of the schema
already works and isn't touched. `lib/coverage.ts` (`checkCoverage`) and `lib/alternatives.ts`
(`findAlternatives`) are reused unchanged; they only ever read those tables, never `patients`.

## Removed
The `patients`/`patient_meds` shape from `backend` (id, name, age, language, embedded plan +
meds) and `alert_status` (old alert-workflow table) are dropped -- they don't fit "nothing else
about the patient, ever." A same-shaped-table migration was run once by hand against the
existing local DuckDB file (`DROP TABLE` + reopen) since `CREATE TABLE IF NOT EXISTS` cannot
change an existing table's columns; a fresh rebuild-from-scratch DB never needs this, since it
never has the old tables. See PROGRESS.md for what else this pivot removed and why.
