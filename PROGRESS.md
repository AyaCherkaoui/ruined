# PROGRESS

Backend-only build on the `backend` branch (local commits, no push). Every coverage decision
comes from our data + deterministic code, never an LLM.

## Status

| # | Task | Status |
|---|------|--------|
| 1 | Download latest quarterly CMS SPUF, read record layout | done |
| 2 | Python + DuckDB loader (Georgia only) | done |
| 3 | Drug normalizer (RxNav / RxClass) + drugs cache | done |
| 4 | checkCoverage + tests | done |
| 5 | findAlternatives + tests | pending |
| 6 | Seed 20 synthetic patients | pending |
| 7 | API routes | pending |
| 8 | Change tracker + /api/alerts | pending |

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

## Assumptions log
1. "Latest quarterly" = Q2 2026 SPUF (2026-07-01 posting), not the newer monthly files.
2. Record layout PDF lives beside the dataset on data.cms.gov, not inside the zip.
3. Raw files are read as Latin-1.
4. "Georgia plans" = H plans with a GA county + R plans in MA region 8 (GA + SC, none exist in this file)
   + S plans in PDP region 10. Plan-file county rows are collapsed to one row per plan.
5. Plans with PLAN_SUPPRESSED_YN='Y' are excluded (they have no rows in any other file).
6. Only the four requested tables are loaded; the insulin cost file, excluded-drug, indication-based and
   pharmacy-network files are skipped (see known issues).
7. Amounts are stored as DOUBLE (not DECIMAL) so the Node client returns plain numbers; money is rounded to cents at the edge.
8. Pricing keeps DAYS_SUPPLY 30 and 90 only (60-day rows dropped) — `--pricing-days` changes that.
9. DATABASE_URL is not set on this machine, so the DuckDB file is the backend. A Postgres adapter for `lib/db.ts` is NOT written (it could not be tested here); the schema and all SQL are kept portable for it.
10. "Same class" = same ATC level-4 class (finer than VA/EPC classes; ATC-3 would suggest SGLT2 inhibitors to a metformin patient).
12. Cost sharing uses **standard retail** (non-preferred) by default: it is always offered, whereas preferred-pharmacy cost share is "not offered" on 426 of 773 plan/tier rows. `pharmacy: "preferred"` switches (falls back to the other if not offered).
13. "restricted" = any of PA, step therapy or quantity limit (one definition used everywhere, incl. "no restrictions" in alternatives). The three flags are returned separately so a UI can tell a routine QL from a PA.
14. Where a formulary lists several NDCs for one RXCUI (never happens in this file) we take the lowest tier, OR the flags, and the median unit cost.
15. Estimates ignore: deductible, coverage phases / the 2026 $2,100 out-of-pocket cap, manufacturer discount program, low-income subsidy, mail-order/90-day pricing, pharmacy dispensing fees.
11. A fuzzy (RxNav approximate) match can pick a near-miss drug, so responses always echo the matched RxNorm name for a human to verify.

## Known issues / not done
- Insulin: 2026 insulin cost sharing has its own file (lesser of $35 copay / 25% rules) that we do not load, so
  insulin estimates use the ordinary tier cost share and may be overstated.
- Cost estimates assume a typical fill quantity, not the patient's actual dose (see Task 4). `Patient.meds[].dose` is free text and is not parsed.
- Dual-eligible / low-income-subsidy members pay LIS copays instead of plan cost sharing; not modeled (seed patients avoid SNP plans).
- 11% of formulary drugs have no ATC class, so they never get (or appear as) alternatives.
- Only the schema init in `openDb()` (read-write) creates tables; an old DB file opened read-only will lack newer tables until a write-mode open has run.
- Excluded-drug and indication-based coverage files are not loaded (only relevant to enhanced plans / niche cases).
