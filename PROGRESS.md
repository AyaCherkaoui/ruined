# PROGRESS

Backend-only build. Every coverage decision comes from our data + deterministic code, never an LLM.
Tasks 1-8 were built on the `backend` branch (local commits, no push); Task 9 and the pivot below
are on the `api` branch (a separate worktree at `../ruined-api`), same rules.

## Status

| # | Task | Status |
|---|------|--------|
| 1 | Download latest quarterly CMS SPUF, read record layout | done |
| 2 | Python + DuckDB loader (Georgia only) | done |
| 3 | Drug normalizer (RxNav / RxClass) + drugs cache | done |
| 4 | checkCoverage + tests | done |
| 5 | findAlternatives + tests | done |
| 6 | Seed 20 synthetic patients | done |
| 7 | API routes | done |
| 8 | Change tracker + /api/alerts | done |
| 9 | Patient/drug search + /api/upcoming (`api` branch) | done |

## Superseded: proactive plan-change alerts (`api` branch, old task numbering 0-4) -- REMOVED tonight

Earlier tonight this branch built a different pivot: instead of a passive dashboard, proactively
alert doctors when a plan change hurts an existing patient, and help them act (switch the med,
notify the patient by voice/text in their language via Grok + ElevenLabs, email the doctor a
digest via Resend). All four tasks were completed, tested (mocked -- no live key was ever
configured, so **no patient data was ever sent to Grok, ElevenLabs, or Resend**), and committed.

| # | Task (old numbering) | Status |
|---|------|--------|
| 0 | Contract types (`PatientAlert`, `Digest`, `PatientMessage`, ...) | done, now removed |
| 1 | Real CMS monthly PUF as `v2-cms`; detect real adverse changes; reassign patients | done, **kept** (see below) |
| 2 | `alert_status` table; `/api/digest`, switch/dismiss/demo-reset | done, now removed |
| 3 | `/api/alerts/:id/message` (Grok translation + ElevenLabs speech) | done, now removed |
| 4 | `/api/digest/email` (Resend) | done, now removed |

**Tonight's new sponsor direction (Impiricus) supersedes this entirely**: minimal patient data --
"nothing else about the patient, ever" -- and the old task 0 contract types all stored `age` and
`language` directly (`PatientAlert.age`, `.language`; the Grok translation feature's entire reason
to exist was per-patient language). Since the new direction says to remove age/language
"everywhere," this feature has no data left to run on. I removed it rather than leave it dead and
half-working:
- `lib/{grok,elevenlabs,resend,message,patientAlerts,alertStatus,digest,digestEmail,drugSearch,upcoming,check,dashboard,patients,changes}.ts` (+ their tests) and `lib/api.test.ts`
- `app/api/{alerts,check,dashboard,demo,digest,drugs,patients,upcoming}/**`
- `scripts/{seed-patients,make-v2,find-cms-changes}.ts`

All of this is still in git history on this branch (nothing force-pushed, nothing pushed at all --
no remote exists for `api`), so it is fully recoverable if the notification/digest direction comes
back. **Kept and reused**: `v1` and the real CMS monthly PUF as `v2-cms` (old task 1's real data --
see Task 1 below, this is exactly the comparison the new direction asks for), and the core
deterministic engine (`lib/coverage.ts`, `lib/alternatives.ts`, `lib/drugs.ts`, `lib/rxnav.ts`,
`lib/db.ts`, `lib/display.ts`) which never touched patients at all.

## Pivot: minimal patient data, one-drug pipeline (`api` branch, new task numbering 0-5)

New sponsor direction (Impiricus): minimal patient data, and prove the pipeline end to end with
**one** drug before adding others. See `DATA_MODEL.md` for the schema. Port 3111.

| # | Task | Status |
|---|------|--------|
| 0 | `DATA_MODEL.md` + new tables + `lib/contract.ts` (`Patient`, `Doctor`, `Prescription`, `CoverageChange`) | done |
| 1 | Pick the drug: real v1 vs v2-cms evidence | done |
| 2 | Pipeline: `ingestRelease` / `detectChanges` / `matchPrescriptions` + `scripts/run-pipeline.ts` | done |
| 3 | `scripts/seed-scenario.ts`: 1 doctor, 5 patients | done |
| 4 | `scripts/e2e.ts` + tests | not started |
| 5 | API: `/api/doctors/:id/alerts`, `/api/changes`, `/api/pipeline/run` | not started |

### Task 0 -- data model + contract (done)

Schema in `data/schema.sql` (see `DATA_MODEL.md` for the full description): added `doctors`,
redefined `patients` to `(id, full_name)` only, added `patient_coverage` (the plan enrollment that
used to be columns on `patients`), `prescriptions` (replaces `patient_meds`), `coverage_changes`,
`patient_alerts`; redefined `data_versions` to `(id, source, release_date, file_hash, loaded_at)`
(same `id` values -- `'v1'`, `'v2-cms'` -- that `plans`/`formulary`/etc already use as
`data_version`, just now with metadata attached). Dropped `patient_meds` and `alert_status`.

`lib/contract.ts`: `Patient = { id, fullName }`; removed `age`/`language` from every type that had
them (`Patient`, the old `PatientAlert`/`UpcomingRisk`, all now gone); added `Doctor`,
`Prescription`, `CoverageChange`; redefined `PatientAlert` to match the new `patient_alerts` table
(joined with `patientName`/`drugName` for readability, since the DB row itself only carries ids).
Kept `Plan`, `CoverageResult`, `Alternative` (used internally by the reused coverage/alternatives
engine) and `ChangeType` (same five values as before: `removed`, `tier_increase`,
`new_prior_auth`, `new_step_therapy`, `new_quantity_limit`).

**One-time manual migration** (not part of `schema.sql`, which only ever does
`CREATE TABLE IF NOT EXISTS` and so cannot change an existing table's columns): dropped the old
`patients`, `patient_meds`, `alert_status`, `data_versions` tables from the already-loaded local
`data/ruined.duckdb` once by hand, then reopened so the new schema created them fresh. A from-
scratch rebuild never needs this step.

### Task 1 -- the chosen drug: NovoLog FlexPen, insulin aspart (done)

`v1` (real CMS quarterly SPUF, Q2 2026) and `v2-cms` (real CMS monthly PUF, September 2026) were
already both loaded on this branch (old task 1 of the now-superseded pivot -- see above), which
made this a direct SQL scan rather than a new download. Query: every (formulary, rxcui) on any
Georgia plan where `v1` covered the drug and `v2-cms` either dropped it or made it worse
(higher tier / new PA / new ST / new QL), filtered to drug name / class containing "insulin" or a
known insulin brand.

**Finding**: NovoLog (insulin aspart, human) was dropped **entirely** from the formulary between
`v1` and `v2-cms` on 10 Georgia plans -- all 8 Kaiser Permanente Senior Advantage / Dual Essential
plans under contract **H1170**, plus CareSource Dual Advantage / Dual Advantage Plus under
**H8390** -- while remaining covered on 130+ other Georgia plans (Humana, Wellcare, Aetna, Anthem,
UHC, AARP, HealthSpring, Devoted, BlueAdvantage, SilverScript, Clover, ...). Both NovoLog forms on
the formulary lost coverage identically: the 3 mL FlexPen (rxcui `1653204`) and the 10 mL vial
(rxcui `351926`). **Chosen drug: rxcui `1653204`** ("3 ML insulin aspart, human 100 UNT/ML Pen
Injector [NovoLog]", SBD) -- the FlexPen, the more commonly prescribed outpatient form.

Evidence, via `checkCoverage` itself (not a hand re-derivation) at each version:

| | plan | formulary_id | v1 | v2-cms |
|---|---|---|---|---|
| **lost coverage** | `H1170`-`002` (Kaiser Permanente Senior Advantage Enhanced 1, HMO, non-SNP) | `00026405` | covered, tier 3, no PA/ST/QL, **est. $47.00/mo** | **not_covered** (tier null, cost null) |
| **stayed covered** | `S5884`-`135` (Humana Basic Rx Plan, PDP, non-SNP) | `00026399` | covered, tier 3, no PA/ST/QL, **est. $133.56/mo** | unchanged: covered, tier 3, **est. $133.56/mo** |

(Both plans' segment_id is `000`.) This is a real `removed` change under the new `ChangeType`
enum -- exactly the shape the sponsor asked for ("an insulin brand that lost coverage ... on at
least one plan while staying covered on at least one other plan"), so no fallback to Rybelsus was
needed.

### Task 2 -- pipeline: ingestRelease / detectChanges / matchPrescriptions (done)

Three plain functions in `lib/pipeline/`, plus `scripts/run-pipeline.ts` that runs all three and
prints a report. All three are idempotent; `lib/pipeline/pipeline.test.ts` (12 tests, synthetic
two-version world) checks this directly, and so does running the real script twice in a row
(same 6 `coverage_changes` rows, same `data_versions.loaded_at`, no duplicates).

- **`ingestRelease(entry, db?)`** owns only the `data_versions` bookkeeping row (source, release
  date, file hash, when we loaded it) -- it does **not** parse CMS files itself. It assumes the
  `plans`/`formulary`/`beneficiary_cost`/`pricing` rows for that `dataVersion` id are already
  loaded (by `scripts/load_spuf.py` / `scripts/load_puf_monthly.py`, run separately). Idempotent
  on `fileHash`: same id + same hash is a no-op; same id + a different (non-null) hash replaces
  the metadata row (but still doesn't reload the CMS tables -- that's a separate, deliberate step
  so a metadata-only correction can't accidentally trigger an unwanted multi-GB reload).
  **Extended the manifest entry shape** beyond the four fields in the task description --
  `{ source, releaseDate, filePath, fileHash }` -- to add a required `dataVersion` field (e.g.
  `'v1'`, `'v2-cms'`): without it there is no way to know which `data_version` label an entry's
  hash/date belong to, and that label is what everything else (`plans.data_version`,
  `detectChanges`) actually joins on. **Created `data/releases.json`** (did not exist yet) with
  the two real releases already loaded on this branch: `v1`'s source zip was deleted before this
  pipeline existed (raw CMS files are gitignored, not needed after loading), so its `fileHash` is
  `null` -- a null hash is treated as "always matches an existing row by id," which keeps
  `ingestRelease('v1', ...)` idempotent but means it can't detect a same-id content swap the way a
  real hash can (fine here: nothing will ever re-supply that missing file). `v2-cms`'s hash is a
  real sha256 of `data/raw/2026_20260916.zip` (still present).
  **Fixed a real regression this change would otherwise have caused**: `load_spuf.py` and
  `load_puf_monthly.py` used to `INSERT INTO data_versions VALUES (?, ?, now())` directly, a
  3-column positional insert that would now fail against the redefined 5-column table (and its
  renamed `data_version` -> `id` column). Removed that insert and the matching `DELETE FROM
  data_versions` from both scripts' idempotent-reload loop -- `data_versions` bookkeeping is now
  `ingestRelease`'s job alone.
- **`detectChanges(fromVersion, toVersion, rxcuis?, db?)`** is the generalization of the old
  (removed) `diffFormularies`/`findAdverseChanges`: one SQL `LEFT JOIN` of `formulary` at
  `fromVersion` to `toVersion` on `(formulary_id, rxcui)`, scoped to `rxcuis` when given (else a
  full scan). Only **adverse** changes are recorded -- `removed` (no matching row in `toVersion`),
  `tier_increase`, `new_prior_auth`, `new_step_therapy`, `new_quantity_limit` -- improvements
  aren't. **A drug with more than one simultaneous adverse change gets one `coverage_changes` row
  per `change_type`** (the pipeline test's synthetic drug does exactly this: a tier increase and
  a new prior-auth requirement in the same release produce two rows, not one row with an
  arbitrarily chosen "primary" type). Each
  row's id is a deterministic hash of `(fromVersion, toVersion, formularyId, rxcui, changeType)`,
  which is what makes rerunning idempotent. A full unscoped scan of real `v1` -> `v2-cms` across
  every Georgia formulary found **1,202 adverse changes** in ~1.2s -- fast enough that
  `scripts/run-pipeline.ts` defaults to a full scan; pass specific rxcuis as argv to scope it (the
  6 rows for the two NovoLog RXCUIs across the 3 formularies that dropped it).
- **`matchPrescriptions(changeIds, db?)`**: for each `coverage_changes` row, joins
  `prescriptions` (by `rxcui`) to `patient_coverage` to `plans` **at `toVersion`** (the patient's
  *current* plan must point at the affected `formulary_id` for the change to reach them -- there
  is no historical plan-enrollment tracking, see `DATA_MODEL.md`), then calls the existing
  `checkCoverage` at `fromVersion`/`toVersion` for the cost before/after and `findAlternatives` at
  `toVersion` for the suggested switch (its top result, or null) -- never recomputing either.
  Verified by hand in the test: a tier-2-copay-$10 drug moving to tier-3-coinsurance-25% on a
  $10/unit x 30-unit drug goes from an exact **$10.00 -> $75.00**. Idempotent the same way
  (deterministic id from `(changeId, prescriptionId)`).

### Task 3 -- scripts/seed-scenario.ts: 1 doctor, 5 patients (done)

`npx tsx scripts/seed-scenario.ts` -- idempotent (checks each table before inserting; rerunning
leaves exactly 1 doctor / 5 patients / 5 prescriptions, verified by running it twice and counting
rows). All 5 patients are prescribed the chosen drug (rxcui `1653204`, NovoLog FlexPen):

| patient | plan | v1 (before) | v2-cms (after) |
|---|---|---|---|
| pt-001 Diane Whitfield | `H1170`-`002` (Kaiser, lost coverage) | covered, tier 3, $47.00/mo | **not covered** |
| pt-002 Marcus Reyes | `H1170`-`002` | covered, tier 3, $47.00/mo | **not covered** |
| pt-003 Sandra Nguyen | `H1170`-`002` | covered, tier 3, $47.00/mo | **not covered** |
| pt-004 Harold Betancourt | `S5884`-`135` (Humana, still covered) | covered, tier 3, $133.56/mo | unchanged, $133.56/mo |
| pt-005 Rosa Lindqvist | `S5884`-`135` | covered, tier 3, $133.56/mo | unchanged, $133.56/mo |

`started_at` is `2026-05-01` for everyone -- before both loaded releases, so the drug is a real,
already-in-force prescription at both `v1` and `v2-cms`, not something that only exists because
of how the demo was seeded. Patient/doctor names are invented; ids are visibly synthetic
(`pt-00N`, `doc-001`, and `rx-00N` for `pt-00N`'s prescription, by construction).

## Read this first (decisions that need a human)

1. **Alternatives are not clinically validated.** On real plans the naive "same drug class" rule paired an AML drug with celecoxib and morphine with oxycodone. I restricted class-level swaps to a curated allowlist (`INTERCHANGEABLE_CLASSES` in `lib/alternatives.ts`), so the feature is deliberately narrower than the spec's wording. A pharmacist should review that list before anyone relies on it. (Task 5)
2. **Every dollar figure is an estimate** (`isEstimate: true`), and the biggest assumption is the fill quantity (the CMS file has no dose). Deductibles, the $2,100 out-of-pocket cap, manufacturer discounts, and low-income-subsidy cost sharing are ignored, as instructed. (Task 4)
3. **Two changes outside `/data /scripts /lib /app/api`, both needed to run at all:** `next.config.ts` (`serverExternalPackages` for DuckDB's native binding; without it every route 500s) and `package.json` (deps + scripts). (Task 7)
4. **The record layout PDF is not inside the CMS zip** as the task said; it is published beside it and was downloaded and read. (Task 1)
5. **v2 is synthetic** (labeled as such in the DB) and exists only to demo `/api/alerts`. (Task 8)
6. **No Postgres yet:** `DATABASE_URL` was not set, so everything runs on a local DuckDB file with a portable schema. The Postgres adapter is not written. (Task 3)
7. **Not verified by anyone but me:** all 138 tests pass on a from-scratch rebuild, but the clinical and cost-modeling judgments above are mine, not reviewed.
8. **The real month-over-month CMS diff (pivot task 1) shows ZERO tier increases and ZERO new PA/step-therapy/quantity-limit rows anywhere in Georgia.** Comparing all 33 Georgia formularies between the Q2 2026 quarterly file and the September 2026 monthly file, the only kind of adverse change that occurs at all is a drug dropping off a formulary entirely (1,202 formulary rows across ~33-46 distinct removals per plan). This is consistent with CMS's mid-year "meaningful difference" rules, which restrict insurers from raising cost sharing or adding restrictions on an approved formulary once the plan year has started, but do allow removing a drug (e.g. a manufacturer discontinuation or a negotiated-price/supply change). **Practical effect: every real `PatientAlert` this build can currently produce has `changeType: "removed"`** -- `tier_increase` / `new_prior_auth` / `new_step_therapy` / `new_quantity_limit` are implemented and tested (synthetically) but have no real September-2026 example to point to. A full plan-year rollover (e.g. Jan 2026 -> Jan 2027 files, not available yet) would very likely show the other four. (Task 1)
9. **4 patients were reassigned a real drug (Rybelsus, oral semaglutide) that was actually pulled from every one of our roster's 16 plans in that same monthly file**, because fewer than 4 of the original 20 were hit by the real diff (zero were, in fact -- see #8). This is a real, verified CMS change, not invented data; see Task 1 below for how it was picked and lib/patientAlerts.test.ts for the pinned figures. **Side effect:** 3 of those 4 patients now also cross the dashboard's $50/mo "expensive drug" line on their plan's ordinary (pre-removal) cost share, so `lib/patients.test.ts` / `lib/dashboard.test.ts`'s "how many expensive/overpaying patients" pinned counts moved from 7/6 to 10/9. This is a real consequence of realistic data, not a bug -- documented in both test files.
10. **`PatientAlert.changeType` is one value, but one drug can have more than one real change at once** (e.g. a tier increase AND a new prior-auth requirement in the same monthly diff). Rather than force a priority order and drop information, `buildPatientAlerts` emits ONE ALERT PER (patient, drug, changeType) -- so such a drug produces two alerts sharing the same before/after tier and cost, with different ids and changeTypes. A same-tier cost increase with none of the 5 changeTypes present is invisible to this feed (see #8's note on the contract's 5 fixed types).
11. **`effectiveDate` is not a real per-change date; the formulary files carry no such field.** For `dataSource: "cms"` it's the CMS monthly distribution's period start (`"2026-09-01"`, the closest real date CMS attaches to that snapshot); for `dataSource: "synthetic"` it's the same invented placeholder task 9 used (`"2027-01-01"`). (Task 1)
12. **`GET /api/digest` is read-only.** Nothing in this build currently moves an alert from `"new"` to `"seen"` -- the contract's `AlertStatus` has a `"seen"` value but no task defines what sets it, so `totalAtRisk` in practice only ever counts `"new"` alerts until a future "mark seen" action exists (e.g. opening the alert's detail view). (Task 2)

## Task 1 — download the SPUF (done)

- Source: the cms.gov landing page is a JS app that 301-redirects to data.cms.gov, so the
  script (`scripts/download_spuf.py`) reads the public `https://data.cms.gov/data.json` catalog.
- Latest **quarterly** file: `SPUF_2026_20260701.zip` (Q2 2026, data posted 2026-07-01, 2.5 GB,
  contains files dated 2026-06-25). Saved to `data/raw/` (gitignored).
  The catalog also has *monthly* files (newer, but the task asks for quarterly) — ignored on purpose.
- The zip holds 9 nested zips: basic drugs formulary, beneficiary cost, excluded drugs,
  geographic locator, indication based coverage, insulin beneficiary cost, pharmacy networks
  (6 parts, ~2.4 GB), plan information, pricing.
- **The record layout PDF is NOT inside the zip** (the task says it is). It is published next
  to the dataset as `SPUFRecordLayout-2026.pdf`, plus `Methodology-SPUF-2026.pdf`; both are
  downloaded to `data/raw/` and were read in full.

### What the record layout / methodology says that matters for us
- Plan key = CONTRACT_ID + PLAN_ID + SEGMENT_ID. Plan file -> FORMULARY_ID -> formulary file
  (formulary is per formulary, not per plan; many plans share one).
- Local MA (H) plans have a row **per county** in the plan file (STATE, COUNTY_CODE);
  regional MA (R) use MA_REGION_CODE (8 = Georgia + South Carolina); PDPs (S) use
  PDP_REGION_CODE (10 = Georgia).
- Cost sharing: COST_TYPE 0 = not offered, 1 = copay ($), 2 = coinsurance (0.25 = 25%).
  COVERAGE_LEVEL 0 = pre-deductible, 1 = initial coverage, 3 = catastrophic. DAYS_SUPPLY code 1 = 30 days.
- UNIT_COST is a **per-unit** price (per pill / per mL), not a per-fill price, and the files
  **do not reflect manufacturer discounts** (IRA). The PUF has no dose/quantity field.
- Files are pipe-delimited, and **not UTF-8** (Latin-1: e.g. a Puerto Rico plan named "Óptimo").

## Task 2 — DuckDB loader (done)

`.venv/bin/python scripts/load_spuf.py` (setup: `python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`)
builds `data/ruined.duckdb` (gitignored, 77 MB) from the raw zip in ~15 s. Schema is in
`data/schema.sql` and sticks to types common to DuckDB and Postgres, so it can be pointed at
`DATABASE_URL` later. `DATABASE_URL` is not set on this machine, so DuckDB is the backend for now.

Georgia filter: H plans with STATE='GA'; R plans with MA_REGION_CODE=8; S plans with PDP_REGION_CODE=10;
suppressed plans dropped. Result (`data_version = 'v1'`):

| table | rows |
|-------|------|
| plans | 152 (142 local MA, 10 PDP, 0 regional) |
| formulary | 111,958 (33 formularies) |
| beneficiary_cost | 4,783 |
| pricing | 1,061,320 (30- and 90-day) |

Indexes on the join keys: plans(contract,plan,segment), plans(formulary_id), formulary(formulary_id,rxcui),
formulary(rxcui), beneficiary_cost(contract,plan,segment,tier), pricing(contract,plan,segment,ndc).

Sanity checks run against the loaded data (all passed):
every plan has formulary + pricing rows; each (formulary, rxcui) has exactly **one** NDC, one tier and
one set of PA/ST/QL flags (so lookups are unambiguous); every tier used by a formulary has a
level-1 30-day cost row for every plan using it; tiers 1-6 present.

## Task 3 — drug normalizer + drugs cache (done)

Code: `lib/rxnav.ts` (API client), `lib/drugs.ts` (normalizer + cache), `lib/db.ts` (DB layer), `scripts/warm-drug-cache.ts`.
Tests: `lib/drugs.test.ts` (mocked RxNav, runs offline; `RXNAV_LIVE=1 npx vitest run lib/drugs.test.ts` adds a real-API smoke test — passes).

- `normalizeDrug(db, "Lipitor 40 mg")` -> `{ rxcui, name, tty, ingredient, classId/className, doseFormGroup, genericRxcui }`.
  Order: cached alias -> RxNav exact/normalized name -> RxNav approximate match. Everything cached in `drugs` + `drug_aliases`.
- Formularies list **SCD (generic) / SBD (brand)** RXCUIs, so those beat components/ingredients/brand names when a match is ambiguous.
  Found via live testing: an exact hit on a partial concept (`lisinopril 10 mg` -> SCDC, no dose form) is upgraded to the full SCD.
  A bare ingredient or brand (`Ozempic`, `insulin glargine`) has no strength, so it is returned as IN/BN as-is (the check API turns those into a pick-list).
- Class = the drug's **ATC level-4** class from RxClass (e.g. `C10AA` statins). One class per drug; lowest class id if several. Combination products get no class (the classes of their parts say nothing about the combo). Brands (SBD) also store `generic_rxcui` (Lipitor -> atorvastatin) for the alternatives logic.
- **Warmed the cache for all 4,791 RXCUIs on the Georgia formularies**: 0 failures, 4,246 (89%) have an ATC class (rest are combinations / drugs RxClass has no ATC class for). Result committed as `data/drug_cache.jsonl` (1.4 MB) so the DB rebuilds offline: `npm run warm-drugs -- --import-only`.
- RxNav client throttles to ~15 req/s (NLM limit is 20) and retries 429/5xx with backoff.
- DB layer is DuckDB (`@duckdb/node-api`) behind a small `Db` interface (`query`/`run` with `$1` params). `RUINED_DB` env overrides the file path. `openDb()` applies `data/schema.sql` (idempotent); read-only opens do not.
- Dev tooling added: vitest **3** (vitest 5 needs `@types/node` >= 22 but the project pins ^20) and tsx (scripts run as `tsx scripts/x.ts`; project is CommonJS so scripts use an async `main()`).

## Task 4 — checkCoverage (done)

`lib/coverage.ts`: `checkCoverage(contractId, planId, segmentId, rxcui, opts?) -> CoverageResult` (exact contract type, `isEstimate: true` always).
Unknown plan -> `PlanNotFoundError`. `coverageForRxcuis()` does the same for many drugs in 4 queries (used by alternatives / dashboard / alerts).

How the estimate is built (all deterministic, from the loaded CMS data):
1. **Coverage**: is the RXCUI on the plan's formulary (plan -> FORMULARY_ID -> formulary)? Tier, PA / step therapy / quantity limit flags come from that row. Not on the formulary -> `not_covered`, tier null, cost null.
2. **Cost share**: `beneficiary_cost` for the plan + tier, **coverage level 1 (initial coverage), 30-day supply** (so deductibles / pre-deductible rows are ignored, per the task). Copay = flat $ but never more than the drug costs; coinsurance = % x drug cost, clamped to the plan's min/max $ when set.
3. **Drug cost** = 30-day `pricing.unit_cost` x quantity.
4. **Status**: `restricted` = covered with any of PA / step therapy / quantity limit; otherwise `covered`.

Tests (`lib/coverage.test.ts`, 43): pure-logic tests (cost share, copay/coinsurance, quantity rules) + real-data tests for **7 common drugs x 3 real plans** (HealthSpring copay design, Humana PDP with 25% coinsurance, AARP PDP with 16%), a real prior-auth drug (Ozempic), a real step-therapy specialty-tier drug (Exxua, ~$434/mo), a not-covered case (Kaiser), preferred-pharmacy and dose overrides. Expected values were computed independently in Python from the raw tables, not from the code under test. They are pinned to the Q2 2026 data (a different quarter will legitimately change them).

**Bug found while hand-verifying, and the decision it forced:** the CMS file has no dose, and my first version priced the fill at the plan's own quantity limit. That priced Eliquis at 30, 60 or 74 tablets depending on the plan. Now the quantity is a property of the *drug*: the smallest 30-day quantity that at least 20% of the formularies that set a QL agree on (Eliquis 5 mg -> 60, Farxiga -> 30), capped by the plan's own QL if lower. With no QL anywhere: oral = 30 units (1/day), other dose forms = 1 unit. `quantityPer30Days` overrides it when a real dose is known.

## Task 5 — findAlternatives (done)

`lib/alternatives.ts`: `findAlternatives(plan, rxcui, opts?) -> Alternative[]` (exact contract type; top 3; sorted **no restrictions first, then lowest estimated cost**, then tier / name / rxcui so the order is always deterministic).
Candidates are covered by the same plan and cheaper for the patient (`includeCostlier` opts out). If the current drug is not covered at all, covered candidates come back with `monthlySavings: 0`.

**Two kinds of candidate:** (1) a brand's *exact generic equivalent* (RxNorm `tradename_of`), e.g. Synthroid -> generic levothyroxine ($12.56 -> $0, verified by hand); (2) other ingredients in the same ATC level-4 class + same route family (oral vs injectable).

**This part matters and needs a human (clinician / pharmacist) review.** Scanning real plans with the naive "same ATC class" rule produced clinically absurd or dangerous suggestions: an AML drug -> celecoxib ($20,818 "saved"), hepatitis C therapy -> ribavirin, morphine -> oxycodone, clozapine -> olanzapine, Multaq -> amiodarone, a maintenance LABA inhaler -> a rescue SABA, oral vancomycin -> nystatin, and starter packs priced as if they were monthly drugs. ATC classes are not therapeutic-substitution groups. So, all deterministic, in code, and tested:
- **Curated `INTERCHANGEABLE_CLASSES`** (25 ATC-4 classes: statins, ACE/ARB, DHP CCBs, selective beta blockers, thiazide/loop diuretics, factor Xa inhibitors, GLP-1 / SGLT2 / DPP-4 / sulfonylureas, PPIs, H2 blockers, SSRIs, cholinesterase inhibitors, triptans, CGRP antagonists, alpha blockers, 5-ARIs, urinary antispasmodics, bisphosphonates, xanthine oxidase inhibitors, prostaglandin eye drops, nasal steroids, leukotriene antagonists). Class-level swaps only happen inside it. Opioids, stimulants, benzodiazepines, antiepileptics, antipsychotics, antiarrhythmics, heparins, insulins, inhalers, thyroid, oncology, immunology and anti-infectives are deliberately out. **Extend it only with clinical sign-off.**
- **Specialty-tier drugs** (the plan's own `TIER_SPECIALTY_YN`) get no class-level alternatives, as source or alternative.
- **Only single clinical drugs (SCD/SBD)**: never starter packs / kits (GPCK/BPCK).
- **One entry per ingredient, shown as its worst-case product** (most restricted, then most expensive). We cannot know which strength is dose-equivalent, and picking the cheapest strength systematically overstated savings (Eliquis 5 mg -> rivaroxaban 2.5 mg). Any saving shown holds whichever strength the prescriber picks.
- The brand -> exact-generic path is exempt from the class and specialty guardrails (it is the same drug).
These are class-level suggestions for the prescriber to review, not validated clinical interchanges. Practical effect on real 2026 Georgia plans: brand-to-brand swaps usually save $0-10 (they share a copay tier); the meaningful savings come from brand -> generic and from moves to a lower tier.

Tests: `lib/alternatives.test.ts` (22, synthetic plan with numbers we control: ordering, dedupe, worst-case, cheaper-only, packs, class/specialty guardrails, generic exemption) and `lib/alternatives.real.test.ts` (9, real data: verified examples plus a property test over ~300 real drugs on two plans checking every rule at once).

## Task 6 — 20 synthetic patients (done)

`npx tsx scripts/seed-patients.ts` (idempotent; deterministic; stop any dev server first, DuckDB allows one writer) fills `patients` + `patient_meds` (schema in `data/schema.sql`). Read side: `lib/patients.ts` (`listPatients`, `getPatient` -> the contract's `Patient`, plan names joined from the real CMS plan data).

- 20 patients (`pt-001`..`pt-020`, names/ages/languages invented, ids visibly synthetic) on **16 real Georgia plans** (stand-alone PDPs plus local MA HMOs/PPOs: Humana, Wellcare, AARP/UHC, Aetna, HealthSpring, Anthem, BlueAdvantage, Clover, Devoted, Kaiser, SilverScript), **2-4 meds each**, real RXCUIs with RxNorm names from the drug cache, doses as free text.
- **7 patients on expensive drugs** (est. monthly cost >= $50 on their plan): Ozempic ($265, prior auth), Eliquis ($62), Trulicity ($249, PA), Tradjenta + Jardiance ($126 / $51), Lumigan + Edarbi ($53 / $108), Toujeo insulin ($275), Myrbetriq + Synthroid ($110 / $12.56). The other 13 take common generics (statins, ACE/ARBs, metformin, amlodipine, levothyroxine, PPIs...). Several expensive patients sit on the same coinsurance PDP (Humana Basic Rx) on purpose: same drugs, very different cost than on copay plans.
- The script validates against the real tables before writing: plan exists, plan is **non-SNP**, every RXCUI is in the drug cache. Every seeded med is covered by its patient's plan in v1 (so a v2 tier change is a real change).
- `lib/patients.test.ts` (9 tests): 20 unique ids, exact `Patient` shape, 2-4 distinct meds, real non-SNP GA plans with names from CMS, 10+ distinct plans, 5-7 expensive, all meds covered.

## Task 7 — API routes (done)

All handlers are thin (`app/api/**/route.ts`); logic and tests live in `lib/`. Every response is JSON; errors are `{ "error": "..." }`. Verified three ways: unit tests, the route handlers called directly (`lib/api.test.ts`), and **real HTTP against `next dev`** (curl) plus a clean `next build`.

| Route | Returns | Notes |
|-------|---------|-------|
| `GET /api/patients` | `Patient[]` | 20 synthetic patients |
| `GET /api/patients/[id]` | `Patient` | 404 if unknown |
| `POST /api/check` | `CheckResponse` `{ coverage, alternatives }` | body below |
| `GET /api/dashboard` | `DashboardResponse` | 6 of 20 at risk, $298.86/mo potential savings |
| `GET /api/alerts` | `CoverageAlert[]` | Task 8 |

`POST /api/check` body (the contract has no request type, so this is my definition, in `lib/check.ts`): the plan as `patientId` **or** `contractId` + `planId` [+ `segmentId`, default `000`], and the drug as `rxcui` **or** `drugName`.
- `drugName` goes through the normalizer (RxNav string matching, cached). A **bare ingredient or brand** ("Ozempic", "apixaban") has no strength, so no formulary lists it: the API answers **422** with `matched` and a `choices` pick-list of that drug's products on the patient's plan, rather than guessing a strength.
- 400 bad/missing input · 404 unknown patient / plan / drug name · 422 ambiguous name · 502 RxNav unreachable (a real DB error stays a 500).

**Dashboard definition** (`lib/dashboard.ts`): a med is flagged if the plan does not cover it, or an alternative saves >= **$10**/month, or it costs the patient >= **$100**/month (then `bestAlternative` is `null` when nothing cheaper exists, which is what the contract's nullable field is for). A patient is at risk if any med is flagged; `worstDrug` is picked among the *flagged* meds only. `totalPotentialMonthlySavings` sums the shown alternatives' savings. A bug was caught in review of real output before it shipped: choosing the "worst" drug among all meds let a $1 saving on a generic hide a $265 drug (regression test added).

**Deviation from "only /data, /scripts, /lib, /app/api" (needed for the backend to run at all):**
- `next.config.ts`: `serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"]`. Without it Turbopack tries to bundle DuckDB's native binding and every route returns 500 (`Module not found: @duckdb/node-bindings-darwin-x64/duckdb.node`, reproduced). It is not on Next's built-in external list.
- `package.json` / lockfile: dependencies (`@duckdb/node-api`, dev: vitest, tsx) and `test` / `warm-drugs` scripts.

Operational notes: DuckDB allows **one writer process**, so a running `next dev` blocks `scripts/*` and the tests' read-only opens; stop the server first. (`lib/api.test.ts` works on a temp copy of the DB for this reason.) No auth, pagination or response caching (out of scope tonight); the dashboard takes ~0.6 s for 20 patients.

## Task 8 — change tracker + alerts (done)

`lib/changes.ts` (`diffFormularies`, `buildAlerts`), `scripts/make-v2.ts`, `GET /api/alerts` -> `CoverageAlert[]` (exact contract type).

- **v2 is SYNTHETIC** and labeled so (`data_versions.source` = "SYNTHETIC: copy of v1 with 6 formulary tier increases ... not CMS data"). `npx tsx scripts/make-v2.ts` copies all four v1 tables to `data_version = 'v2'` (plans, formulary, beneficiary_cost, pricing; row counts verified equal) and then raises 6 formulary tiers, deterministically:
  - the 5 seed-patient meds with the highest cost, one per patient, each moved to the nearest higher tier that every plan on that formulary has a cost row for **and** that really raises that patient's cost: Toujeo $274.82 -> $373.75, Ozempic $264.97 -> $360.35, Trulicity $249.17 -> $299.01, Tradjenta $126.14 -> $171.56, Myrbetriq $110.49 -> $150.27 (tier 3 -> 4; 34% / 30% coinsurance). All five v2 figures were re-derived independently from the raw tables.
  - lisinopril 20 mg (the drug the most patients share) tier 1 -> 2: **one formulary change that hits two patients** ($0 -> $1), to exercise the patient matching.
- **Diff**: SQL join of v1 and v2 formulary rows on (formulary_id, rxcui) where the tier differs -> 6 rows. **Match**: each patient's plan -> FORMULARY_ID -> their meds; old/new tier and cost come from `checkCoverage` at each version (`dataVersion` option). Formularies are shared by many plans, so a change reaches every patient on any plan using that formulary.
- **Alert rule**: only adverse changes, i.e. the drug moved to a higher tier or its estimated cost went up (improvements are not alerts). Sorted by cost increase, then patient, then drug. `GET /api/alerts` returns 7 alerts on the seeded data.
- Tests (`lib/changes.test.ts`, 9 + 1 route test): a synthetic two-plan / two-formulary world covering cost increase, same-cost tier move (still an alert), improvement (no alert), unchanged drug, drug nobody takes, plan on an unchanged formulary, ordering, v1/v2 independence; plus pinned real-data checks (exactly 6 rows differ, nothing else differs, all 7 alerts).

## Task 9 — patient/drug search + /api/upcoming (`api` branch, done)

New contract types (added verbatim as specified): `DrugOption` and `UpcomingRisk` in `lib/contract.ts`.

| Route | Returns | Notes |
|-------|---------|-------|
| `GET /api/patients/search?q=` | `Patient[]` | case-insensitive substring on name, max 8 (`lib/patients.ts`'s `searchPatients`) |
| `GET /api/drugs/search?patientId=&q=` | `DrugOption[]` | max 10, scoped to that patient's plan **formulary** (`lib/drugSearch.ts`'s `searchPlanDrugs`), matched on the RxNorm name |
| `GET /api/upcoming` | `UpcomingRisk[]` | one row per adverse v1 -> v2 change per patient, sorted by dollar increase (`lib/upcoming.ts`) |

- **`searchPatients`**: generalized `lib/patients.ts`'s internal `load()` to take an optional name filter (`ILIKE '%q%'`) and a `LIMIT`, instead of adding a parallel code path. 400 if `q` is missing/blank; empty query -> `[]` at the library level too.
- **`searchPlanDrugs`** lives in its own module (`lib/drugSearch.ts`), not `lib/drugs.ts`: it needs `loadPlanContext` from `lib/coverage.ts`, and `coverage.ts` already imports `lib/drugs.ts` (for `getDrug`) -- putting it in `drugs.ts` would create a circular import. `drugSearch.ts` sits above both, like `alternatives.ts` / `check.ts` / `changes.ts` already do.
- **`displayName`** (both `DrugOption` and `UpcomingRisk`): "brand in brackets, else first three words" -- this is the **same rule the frontend branch already uses** (`components/format.ts`'s `displayDrugName`, e.g. `... [Myrbetriq]` -> `Myrbetriq`). Re-implemented in `lib/display.ts` rather than imported: `components/` is UI, out of scope for this build, and the backend can't depend on it. Kept deliberately tiny (pure string function) so the duplication is cheap and hard to drift.
- **`/api/upcoming` reuses `lib/changes.ts`** as instructed: extracted the alert-matching loop (diff -> which patients/meds got worse) into `findAdverseChanges()`, which `buildAlerts` (Task 8) now also calls -- so /api/alerts and /api/upcoming can never disagree about *which* changes are adverse, only how they're presented. Verified this refactor is behavior-preserving: all of Task 8's existing tests (synthetic + the 7 pinned real alerts) still pass unchanged.
- **`bestAlternative`** is `findAlternatives(patient.plan, rxcui, { dataVersion: 'v2' })` -- i.e. computed against the *upcoming* tier/cost, so the saving shown is "what you'd save switching now, before the hike lands," not against the current (v1) cost. On the real seeded data: Toujeo and Ozempic get `null` (insulin / GLP-1 -- no class-level alternatives, per Task 5's guardrails); Trulicity, Tradjenta, Myrbetriq and both lisinopril rows get a real switch.
- **`effectiveDate = "2027-01-01"` is invented.** v2 (`scripts/make-v2.ts`, Task 8) is a synthetic change-tracker copy with no real CMS effective date attached to it; this is a placeholder date for the demo, hardcoded as `UPCOMING_EFFECTIVE_DATE` in `lib/upcoming.ts`. A real system would carry the actual CMS plan-year effective date through from wherever v2 comes from.
- **`percentIncrease` is `null`** when either monthly cost is `null`, or the old cost is `0` (e.g. the two lisinopril alerts go $0 -> $1: a "percent increase" off a $0 base is undefined, not `Infinity`).
- Tests: `lib/patients.test.ts` (+4), `lib/drugSearch.test.ts` (5, synthetic: match/case-insensitivity/displayName/plan-scoping/limit) + `lib/drugSearch.real.test.ts` (2, real: pt-007 "myr" -> Myrbetriq), `lib/upcoming.test.ts` (10: synthetic percent/sort/alternative-under-v2 logic + real pinned figures cross-checked against Task 8's alert numbers), `lib/api.test.ts` (+6 route-handler tests). 26 new tests, 164 total, all passing.
- **Verified over real HTTP on port 3111** (`npx next dev -p 3111`, not `npm run dev`'s default port -- per instruction): `curl` against all three new routes plus the 400/404 error paths, output matched the direct-handler tests exactly (e.g. `/api/drugs/search?patientId=pt-007&q=myr` returned the same 3 Myrbetriq products, `/api/patients/search?q=eve` and `?q=EVE` both returned only Evelyn Park). Also ran a clean `next build`: all 3 new routes show up as dynamic (`ƒ`) alongside the existing ones.

## Task 0 — contract types for the pivot (done, committed within 10 min as instructed)

Added verbatim to `lib/contract.ts`: `ChangeType`, `AlertStatus`, `PatientAlert`, `Digest`,
`PatientMessage`. Kept Task 9's `DrugOption` / `UpcomingRisk` and everything from Tasks 1-8 --
nothing removed, only appended. Typechecked clean (the one pre-existing `tsc` error, `app/layout.tsx`'s
`LayoutProps`, is a UI file outside this build's scope and predates this change).

## Task 1 — real CMS monthly PUF as `v2-cms`; detect real changes; reassign patients (done)

**Download & load** (mirrors Task 1/2's quarterly pipeline): `scripts/download_puf_monthly.py` reads
the same `data.cms.gov/data.json` catalog for dataset title *"Monthly Prescription Drug Plan Formulary
and Pharmacy Network Information"* and picks the newest by `temporal` end date. Newest at the time of
this build: **`2026_20260916.zip`** (period 2026-09-01 to 2026-09-30, posted 2026-09-16, 2.19 GB) --
newer than the Q2 2026 quarterly file used for v1, as required. `scripts/load_puf_monthly.py` loads it
Georgia-only into `data_version = 'v2-cms'`, same filter rule as `load_spuf.py`.
- **This monthly PUF has no pricing file** (confirmed against its own record-layout PDF,
  `data/raw/PUFRecordLayout-2026.pdf`: no PRICING FILE section, unlike the quarterly SPUF's). Per the
  instructions, `v2-cms` pricing is a straight copy of `v1`'s 1,061,320 pricing rows, logged both in
  the script's own stdout and in `data_versions.source`. An NDC that appears only in the new formulary
  (none do, in practice) would price as unknown/null, same as any other unpriced NDC.
  Result: 152 plans, 112,513 formulary rows, 4,783 beneficiary_cost rows, 1,061,320 pricing rows (copied).
- All 20 seeded patients' plans still exist in `v2-cms` (checked directly; see Known issues for what
  happens to a patient whose plan doesn't -- `changesForPatient` in `lib/patientAlerts.ts` skips and
  logs, it does not crash the whole feed).

**Detecting adverse changes** (`lib/patientAlerts.ts`, replacing the Task 8 `diffFormularies`
approach for this feed): rather than pre-computing a global (formulary_id, rxcui) diff and assuming
formulary_id stays stable across periods, `changesForPatient` loads each patient's `PlanContext` under
BOTH data versions and compares `coverageForRxcuis` output directly -- this works whether or not the
plan's `formulary_id` changed (it happens to be stable for all 16 roster plans between these two
files, verified directly, but the code no longer assumes it). A change only counts if the drug was
already covered (`before.status !== "not_covered"`): a plan newly covering something a patient
happens to list is not "a change that hurts an existing patient". Five checks map to the five
`ChangeType`s (`removed`, `tier_increase`, `new_prior_auth`, `new_step_therapy`,
`new_quantity_limit`); **more than one can fire for the same drug**, and each becomes its own
`PatientAlert` (id `` `${patientId}:${rxcui}:${changeType}` ``) -- see "Read this first" #10.
**Ran this for real first** (`scripts/find-cms-changes.ts`, kept for reproducibility) before writing
any reassignment: it found the true Georgia-wide diff is 100% removals, 0 tier/PA/ST/QL changes (see
"Read this first" #8), and it's how Rybelsus was found.

**Patient reassignment** (instructed: "if fewer than 4 ... are affected, re-assign meds for some of the
13 generic-only patients"): the real diff against the original 20 patients hit **zero**. Scanning all
16 roster plans' formularies found **semaglutide 14 MG Oral Tablet [Rybelsus] (rxcui 2200650) removed
from every single one of them** between v1 and v2-cms (along with dapagliflozin/Farxiga on several,
and a long tail of vaccines/oncology/HIV drugs -- Rybelsus was the best candidate: common, oral,
clinically coherent to add). Of the 13 generic-only patients, exactly 4 were already on metformin
(pt-009 Carlos Ramirez, pt-012 Fatima Ali, pt-018 Tran Van Nguyen, pt-020 Anita Sharma) -- Rybelsus
was added as their 4th med (`scripts/seed-patients.ts`, `RX.rybelsus14`), a clinically ordinary
second-line oral agent for a metformin patient. **Evelyn Park (pt-007), Harold Bennett (pt-004) and
James Carter (pt-006) were left untouched**, as instructed (they weren't reassignment candidates
anyway -- they're in the 7-patient "expensive" group, not the 13). Re-ran `seed-patients.ts`; the real
diff against the new roster is now exactly the 4 patients required:

| patient | plan | v1 tier / cost | v2-cms |
|---|---|---|---|
| pt-009 Carlos Ramirez | Wellcare Simple Open (H0111-001) | tier 3, $238.41/mo (25% coinsurance) | removed |
| pt-012 Fatima Ali | HumanaChoice (H5216-073) | tier 3, $47.00/mo (flat copay) | removed |
| pt-018 Tran Van Nguyen | Devoted Choice (H5453-001) | tier 3, $182.28/mo (19% coinsurance) | removed |
| pt-020 Anita Sharma | AARP Saver (S5921-355) | tier 3, $188.90/mo (18% coinsurance) | removed |

All four had prior authorization + a quantity limit on Rybelsus in v1 (real CMS flags, unrelated to
the removal). `bestAlternative` is `null` for all four: Rybelsus's real RxClass ATC-4 class (GLP-1
analogues, A10BJ) is on `INTERCHANGEABLE_CLASSES`, but `findAlternatives` also requires the same
RxNorm dose-form group, and the only other GLP-1s on these formularies (Ozempic, Trulicity) are
injectables, not oral -- same guardrail that already makes Ozempic/Toujeo alternative-less in Task 9.

**`CHANGE_SOURCE` switch** (`lib/patientAlerts.ts`'s `resolveChangeSource()`): env `CHANGE_SOURCE=cms`
(or unset) -> compares v1 vs `v2-cms` (real), `dataSource: "cms"`, `effectiveDate: "2026-09-01"`.
`CHANGE_SOURCE=synthetic` -> falls back to v1 vs Task 8's synthetic `v2`, `dataSource: "synthetic"`,
`effectiveDate: "2027-01-01"` (unchanged from Task 9). Every `PatientAlert` and `Digest` alert carries
its `dataSource`, so a UI can distinguish real CMS findings from the demo fallback.

Tests: `lib/patientAlerts.test.ts` (15: `alertId`/`parseAlertId` round-trip, `resolveChangeSource`'s
3 branches, a 10-drug synthetic world covering every `ChangeType` including the "not covered before"
and "multiple changes on one drug" cases, `getPatientAlert` lookups, and a real-data block pinning
the 4 Rybelsus alerts above). **Side effect on existing pinned tests, fixed in this task**:
`lib/patients.test.ts` and `lib/dashboard.test.ts` had hardcoded "7 expensive / 6 overpaying" from
Task 6/7; adding a real ~$960/mo drug to 4 patients pushed those to 10/9 (3 of the 4 cross the
$50/mo line; pt-012's copay plan keeps her at exactly $47). Updated both with the real recomputed
numbers and a comment explaining why -- this is correct behavior on more realistic data, not a bug.

## Task 2 — alert workflow state + `/api/digest`, switch, dismiss, demo reset (done)

`alert_status` table (`data/schema.sql`): `alert_id` (PK), `status`, `switched_to`, `created_at`,
`updated_at`. Alerts themselves are never stored -- they're recomputed from the loaded data on every
request (`buildPatientAlerts`); this table only remembers what a doctor DID about a given alert id. A
missing row means `status: "new"`. `lib/alertStatus.ts`'s `setAlertStatus` does an `UPDATE` when a row
exists (preserving `created_at`) and an `INSERT` otherwise -- **not** delete-then-reinsert like
`lib/drugs.ts`'s `saveDrug`: round-tripping an existing row's `TIMESTAMP` value back out as a bound
parameter throws `Cannot create values of type ANY` in `@duckdb/node-api` (`SqlValue` in `lib/db.ts`
is only string/number/boolean/null). Found this by writing the test first and watching it fail with
that exact error, then fixed with a plain `UPDATE`.

| Route | Behavior |
|---|---|
| `GET /api/digest` | `Digest` -- dismissed alerts excluded entirely; `totalAtRisk` = count of `new`/`seen`; `totalMonthlyIncrease` / `totalMonthlySavingsIfSwitched` sum over the shown (non-dismissed) alerts, nulls as 0; read-only, no status side effects (see "Read this first" #12) |
| `POST /api/alerts/:id/switch` | body `{ rxcui }` -> sets status `"switched"`, `switchedTo` = that rxcui; 400 if `rxcui` missing, 404 if the id doesn't parse or no longer names a real adverse change |
| `POST /api/alerts/:id/dismiss` | sets status `"dismissed"`; same 404 rule |
| `POST /api/demo/reset` | deletes every `alert_status` row (every alert back to `"new"`) -> `{ reset: true }` |

`getPatientAlert(id)` (`lib/patientAlerts.ts`) parses the id back into patientId/rxcui/changeType,
loads just that one patient, and recomputes -- it does not require scanning all 20 patients to answer
one alert lookup. Switch/dismiss don't validate that `rxcui` is a real covered alternative (the
doctor may pick any drug, not necessarily our `bestAlternative` suggestion); they do 404 on a
made-up/stale alert id rather than silently writing a status for a change that isn't real.

Tests: `lib/alertStatus.test.ts` (4: default/new, persists, updates-not-duplicates + preserves
created_at, reset) and `lib/digest.test.ts` (7: dismissed exclusion, `totalAtRisk` counting,
sum-with-nulls-as-0 for both totals, sort + status/switchedTo pass-through, empty-roster zeros).
**Verified over real HTTP on port 3111**: `GET /api/digest` (4 real alerts), `POST .../switch` with a
body, `POST .../dismiss`, a 404 on a bogus id, a 400 on a missing `rxcui`, `POST /api/demo/reset`, and
confirmed the digest reflects each state change and resets cleanly afterward.

## Task 3 — patient notification: Grok translation + ElevenLabs speech (done)

`POST /api/alerts/:id/message -> PatientMessage`. Numbers never come from an LLM, per the core
rule: `lib/message.ts`'s `buildEnglishText(alert)` is a plain deterministic template built only
from `PatientAlert` fields (drug names, `effectiveDate`, `oldMonthlyCost`/`newMonthlyCost`,
`bestAlternative`'s name/cost/savings) -- one branch per `ChangeType`, omitting a cost sentence
entirely when a cost is `null` rather than printing "null". xAI Grok (`lib/grok.ts`) only ever
translates that finished English sentence into the patient's language; it is never given raw
numbers to compute or asked to phrase a dollar amount itself.

- **Verification, not trust**: `numbersMatch()` extracts every digit run (`\d+(\.\d+)?`, so
  `"2026-09-01"` -> `["2026","09","01"]`, `"$238.41"` -> `["238.41"]`) from both the English
  template and the translation and compares them as a multiset. Any mismatch -- a mistranslated
  digit, a dropped date, a "helpfully" localized decimal separator -- **falls back to the English
  text** rather than risk a patient reading a wrong dollar figure. `language` on the returned
  `PatientMessage` reflects what `text` actually is (`"English"` on fallback), not what was
  requested.
- **Skips Grok entirely for English-language patients** (`alert.language` case-insensitively
  `"english"`) -- no network call, no verification needed, `text === englishText`.
- **ElevenLabs** (`lib/elevenlabs.ts`) always uses one multilingual voice/model
  (`eleven_multilingual_v2`, overridable via `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL`) on the
  FINAL text (translated or English-fallback) -- one client handles every patient language. Saved
  to `public/audio/<alertId>-<random>.mp3` (gitignored: generated, not source) and returned as
  `/audio/<file>.mp3`, which Next serves directly from `/public`.
- **Missing keys are a clear error, not a crash**: `GrokClient`/`ElevenLabsClient` throw a shared
  `MissingApiKeyError` (`lib/http.ts`) when `XAI_API_KEY` / `ELEVENLABS_API_KEY` isn't set;
  `errorResponse` maps it to **503** with the exact env var name. Verified for real on port 3111
  with no keys configured: `POST .../message` on a real alert -> `503 {"error":"XAI_API_KEY is not
  configured. Add it to .env to enable this feature."}`; a bogus alert id -> `404` (checked before
  any external call is attempted). Once a real `XAI_API_KEY` is added to `.env`, an English-language
  patient's request would still need `ELEVENLABS_API_KEY` and fail there instead with the same
  clear-503 pattern (covered by the mocked unit test, not re-verified over HTTP since none of the
  4 real alerts are on an English-speaking patient right now).
- **Sets `status: "patient_notified"`** after a message is successfully built, preserving whatever
  `switchedTo` was already recorded (a doctor can both switch the med and notify the patient; the
  status enum only shows the latest action, but `switchedTo` isn't cleared by notifying).
- Model/voice ids (`grok-4-fast`, `eleven_multilingual_v2`, the stock ElevenLabs voice id) are
  **not verified against a live key** (none is configured yet) and are overridable by env var
  (`XAI_MODEL`, `ELEVENLABS_MODEL`, `ELEVENLABS_VOICE_ID`) without a code change if wrong.

Tests (all against injected fake `fetch`, matching `lib/rxnav.test.ts`'s pattern -- no real network
calls): `lib/grok.test.ts` (4), `lib/elevenlabs.test.ts` (3), `lib/message.test.ts` (12: the
template for every `ChangeType`, null-cost omission, a "no invented numbers" property check, the
English-skips-Grok path, a successful translation, the number-mismatch fallback, and the
missing-key error propagating unchanged).

## Task 4 — doctor digest email via Resend (done)

`POST /api/digest/email -> { sent: true, id }`. `lib/digestEmail.ts`'s `digestHtml(digest)` /
`digestSubject(digest)` render straight from the already-computed `Digest` (built by
`buildDigest()`, task 2) -- no new numbers, no LLM: a table of patient / drug / cost before /
cost after / suggested switch / savings, plus the two digest totals in the header. Subject is
exactly the instructed template: `` `${totalAtRisk} of your patients are affected by upcoming
plan changes` ``. Patient/drug names are HTML-escaped (`&`, `<`, `>`) before being inlined, since
they ultimately come from CMS/RxNorm free text, not from a fixed set of safe values.

`lib/resend.ts`'s `ResendClient.send()` posts to Resend's `/emails` endpoint from
`onboarding@resend.dev` (the shared sandbox sender named in the instructions -- needs no domain
verification) and returns Resend's own message id, which the route passes through as `id`.

**Same missing-key pattern as task 3**: `sendDigestEmail()` throws `MissingApiKeyError` for
whichever of `DOCTOR_EMAIL` (checked first, since it's this task's own required setting) or
`RESEND_API_KEY` (checked inside `ResendClient.send`, once `resend.send` is actually called) isn't
set, mapped by `errorResponse` to a **503** with a clear message. Verified for real on port 3111
with neither configured: `POST /api/digest/email` -> `503 {"error":"DOCTOR_EMAIL is not
configured. Add it to .env to enable this feature."}`.

Tests: `lib/resend.test.ts` (4, mocked fetch: missing key, correct from/to/subject/html payload +
returned id, non-2xx -> `ResendError`, no id in response -> `ResendError`) and
`lib/digestEmail.test.ts` (6: subject template including the zero-patients case, the rendered
table has every column, null cost / no-alternative rows show an em dash rather than the string
"null", HTML-escaping of `&`/`<`/`>` in patient and drug names, and `sendDigestEmail` end-to-end
against a mocked `ResendClient`).

**All four pivot tasks (0-4) are now done.** 219 tests passing, typecheck and lint clean, every
new route re-verified over real HTTP on port 3111 after this task landed.

## Rebuild from scratch (the database and raw data are gitignored)

```
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/download_spuf.py          # 2.5 GB CMS quarterly zip + record layout PDFs -> data/raw/
.venv/bin/python scripts/load_spuf.py              # Georgia only -> data/ruined.duckdb, data_version v1 (~15 s)
.venv/bin/python scripts/download_puf_monthly.py   # 2.2 GB CMS monthly zip + record layout PDFs -> data/raw/
.venv/bin/python scripts/load_puf_monthly.py       # Georgia only -> data_version v2-cms (pricing copied from v1)
npm install && npm run warm-drugs -- --import-only # drug cache from data/drug_cache.jsonl (offline)
npx tsx scripts/seed-patients.ts                   # 20 synthetic patients (4 reassigned Rybelsus, task 1)
npx tsx scripts/make-v2.ts                         # synthetic v2 formulary, fallback for CHANGE_SOURCE=synthetic
npm test                                           # 219 tests
npm run dev                                        # API on :3000 (stop it before re-running any script above)
```

## Assumptions log
1. "Latest quarterly" = Q2 2026 SPUF (2026-07-01 posting), not the newer monthly files.
2. Record layout PDF lives beside the dataset on data.cms.gov, not inside the zip.
3. Raw files are read as Latin-1.
4. "Georgia plans" = H plans with a GA county + R plans in MA region 8 (GA + SC, none exist in this file) + S plans in PDP region 10. Plan-file county rows are collapsed to one row per plan.
5. Plans with PLAN_SUPPRESSED_YN='Y' are excluded (they have no rows in any other file).
6. Only the four requested tables are loaded; the insulin cost file, excluded-drug, indication-based and pharmacy-network files are skipped (see known issues).
7. Amounts are stored as DOUBLE (not DECIMAL) so the Node client returns plain numbers; money is rounded to cents at the edge.
8. Pricing keeps DAYS_SUPPLY 30 and 90 only (60-day rows dropped) — `--pricing-days` changes that.
9. DATABASE_URL is not set on this machine, so the DuckDB file is the backend. A Postgres adapter for `lib/db.ts` is NOT written (it could not be tested here); the schema and all SQL are kept portable for it.
10. "Same class" = same ATC level-4 class (finer than VA/EPC classes; ATC-3 would suggest SGLT2 inhibitors to a metformin patient).
11. A fuzzy (RxNav approximate) match can pick a near-miss drug, so responses always echo the matched RxNorm name for a human to verify.
12. Cost sharing uses **standard retail** (non-preferred) by default: it is always offered, whereas preferred-pharmacy cost share is "not offered" on 426 of 773 plan/tier rows. `pharmacy: "preferred"` switches (falls back to the other if not offered).
13. "restricted" = any of PA, step therapy or quantity limit (one definition used everywhere, incl. "no restrictions" in alternatives). The three flags are returned separately so a UI can tell a routine QL from a PA.
14. Where a formulary lists several NDCs for one RXCUI (never happens in this file) we take the lowest tier, OR the flags, and the median unit cost.
15. Estimates ignore: deductible, coverage phases / the 2026 $2,100 out-of-pocket cap, manufacturer discount program, low-income subsidy, mail-order/90-day pricing, pharmacy dispensing fees.
16. "Cheaper" alternatives must cost the patient strictly less; ties (same copay tier) are not suggestions.
17. Synthetic patients avoid SNP plans (D-SNP / C-SNP / I-SNP): their low-income-subsidy or institutional cost sharing is not in plan-level data, so estimates for them would mislead.
18. "Expensive drug" for the seed = estimated patient cost >= $50/month on their plan. It is the patient's cost, not the drug's list price (on copay plans even a $500 drug shows a $47 copay).
19. Dashboard thresholds ($10 saving, $100 cost) are judgment calls, exported as constants in `lib/dashboard.ts`.
20. Alerts cover tier changes only (the contract's `CoverageAlert` has tiers and costs, nothing else): a drug dropped from a formulary or a newly added PA / step-therapy rule is not reported. Those are arguably the worst changes for a patient; the type would need to grow to carry them.
21. v2 exists only to demo the tracker; it changes formulary tiers, not prices or cost-sharing rules.
22. Fill quantity: the CMS file has no dose, so the 30-day quantity is a property of the drug (smallest quantity >= 20% of formularies agree on from their quantity limits; else 30 units oral / 1 unit other forms), capped by the plan's own QL. This makes a drug cost the same on every plan and avoids pricing Eliquis at 30, 60 or 74 tablets by plan. Overridable with `quantityPer30Days`.
23. Alternatives are limited to a curated list of interchangeable ATC classes, no specialty tiers, no packs, and one worst-case product per ingredient (see Task 5). Brand -> exact generic is always allowed. This is more conservative than the literal spec ("same class") on purpose: the literal version produced dangerous suggestions on real data.
24. `/api/patients/[id]` returns exactly the contract's `Patient`; coverage for a patient's meds is fetched with `POST /api/check` (one call per med), rather than inventing an extended patient type.
25. `displayName`'s rule ("brand in brackets, else first three words") is duplicated between `lib/display.ts` (backend, Task 9) and `components/format.ts` (frontend branch's UI) on purpose, not shared: the backend build cannot import from `components/`.
26. `UpcomingRisk.effectiveDate` is a hardcoded placeholder (`"2027-01-01"`), since the synthetic v2 (Task 8) carries no real CMS effective date.
27. `UpcomingRisk.percentIncrease` is `null` (not `Infinity`) when the old cost was `$0` or either cost is unknown.
28. `v2-cms` = the newest CMS **monthly** PUF at build time (September 2026), loaded fresh alongside (not replacing) `v1` (Q2 2026 quarterly) and the synthetic `v2` (Task 8). All three coexist in the same database, distinguished by `data_version`.
29. The monthly PUF has no pricing file, so `v2-cms` pricing is copied verbatim from `v1` (see Task 1); a real system would need the monthly file's own pricing once CMS publishes one, or would need to re-derive it some other way.
30. `PatientAlert.effectiveDate` is not a real per-change date (see "Read this first" #11): `"2026-09-01"` for `dataSource: "cms"` (the monthly distribution's period start), `"2027-01-01"` for `"synthetic"` (unchanged placeholder from Task 9).
31. A drug with more than one simultaneous adverse change produces one `PatientAlert` per `ChangeType`, not one alert with a chosen "primary" type (see "Read this first" #10).
32. `GET /api/digest` never changes any alert's status (see "Read this first" #12); `"seen"` is a contract value with no producer yet in this build.
33. `POST /api/alerts/:id/switch` accepts any non-empty `rxcui` string in the body; it does not verify the drug is actually covered by the patient's plan or is the alert's own `bestAlternative`. The doctor is trusted to pick a real switch.
34. `PatientMessage.language` reflects what `text` actually is, not what was requested: it is the patient's real language on a successful, number-verified translation, and `"English"` whenever translation was skipped (English-speaking patient) or the translation was discarded for changing a number.
35. Grok/ElevenLabs model and voice ids (`grok-4-fast`, `eleven_multilingual_v2`, ElevenLabs' stock "Rachel" voice) are best-effort choices, not verified against a live key; all three are overridable via env (`XAI_MODEL`, `ELEVENLABS_MODEL`, `ELEVENLABS_VOICE_ID`) without a code change.
36. `POST /api/alerts/:id/message` sets status `"patient_notified"` but does not clear `switchedTo` -- the two facts ("doctor switched the med" and "patient was notified") are independent even though `AlertStatus` only stores one current status string.
37. `POST /api/digest/email` sends to a single recipient (`DOCTOR_EMAIL`), not a list; the contract/task both describe one doctor's inbox, not a multi-recipient broadcast.
38. The digest email includes every non-dismissed alert regardless of status (`new`, `seen`, `switched`, `patient_notified`) -- it's a record of everything currently affecting the doctor's patients, not just the unactioned ones (that distinction is what `totalAtRisk` is for).

**Entries 25, 30-38 above describe the "proactive alerts" pivot removed tonight** (see "Superseded"
section above) and no longer apply to any code on this branch; kept for history, not current
behavior. 26-29 and 31 still apply (formulary/version mechanics, not patient-facing).

39. `ManifestEntry` (the `data/releases.json` shape `ingestRelease` reads) has a `dataVersion`
    field beyond the four the task described (`source`, `releaseDate`, `filePath`, `fileHash`):
    without it there's no way to know which `data_version` label a release's metadata belongs to.
40. `ingestRelease` never loads CMS data itself (see Task 2) -- it assumes
    `scripts/load_spuf.py` / `scripts/load_puf_monthly.py` already populated
    `plans`/`formulary`/`beneficiary_cost`/`pricing` for the `dataVersion` id it's given.
41. `detectChanges` only records adverse changes (matches the removed `diffFormularies`'s
    convention and CLAUDE.md's framing, "alerts when coverage changes"); a drug getting *better*
    between versions is not written to `coverage_changes`.
42. `matchPrescriptions` joins the patient's plan to the affected formulary **at `toVersion`**
    (their current enrollment, since `patient_coverage` carries no history) -- not `fromVersion`.
    In practice these are almost always the same formulary; if a patient's plan itself changed
    formularies between releases (not modeled by any seed data here), this would follow the new
    one.
43. `coverage_changes` / `patient_alerts` row ids are deterministic hashes of their natural key
    (not random), which is what makes both pipeline steps idempotent on rerun without a separate
    "have I seen this before" table.

## Known issues / not done
- Insulin: 2026 insulin cost sharing has its own file (lesser of $35 copay / 25% rules) that we do not load, so
  insulin estimates use the ordinary tier cost share and may be overstated.
- Cost estimates assume a typical fill quantity, not the patient's actual dose (see Task 4). `Patient.meds[].dose` is free text and is not parsed.
- Dual-eligible / low-income-subsidy members pay LIS copays instead of plan cost sharing; not modeled (seed patients avoid SNP plans).
- **Alternatives are not clinically validated** (see Task 5): they need pharmacist review before real use; the class allowlist is a starting point.
- Alerts miss formulary removals and new PA / step-therapy rules (see assumption 20).
- Insulins and inhalers get no alternatives (unit / device / dose-conversion differences); brand -> generic still works for them.
- 11% of formulary drugs have no ATC class, so they never get (or appear as) alternatives.
- Only the schema init in `openDb()` (read-write) creates tables; an old DB file opened read-only will lack newer tables until a write-mode open has run.
- Excluded-drug and indication-based coverage files are not loaded (only relevant to enhanced plans / niche cases).
- The real CMS diff (v1 vs v2-cms) currently only ever produces `removed` alerts (see "Read this first" #8); `tier_increase` / `new_prior_auth` / `new_step_therapy` / `new_quantity_limit` are implemented and covered by synthetic tests only, not by a real example.
- No endpoint sets `AlertStatus` to `"seen"` (see assumption 32) -- `totalAtRisk` in `GET /api/digest` only ever reflects `"new"` alerts today.
- `POST /api/alerts/:id/switch` trusts the caller's `rxcui` (see assumption 33); a UI should constrain the choice to `bestAlternative` or another plan-covered drug.
- Task 3 (patient-language voice/text notification) and Task 4 (doctor email digest) are not built yet -- see the Status table.
