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
| 5 | findAlternatives + tests | done |
| 6 | Seed 20 synthetic patients | done |
| 7 | API routes | done |
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
19. Dashboard thresholds ($10 saving, $100 cost) are judgment calls, exported as constants in `lib/dashboard.ts`.
17. Synthetic patients avoid SNP plans (D-SNP / C-SNP / I-SNP): their low-income-subsidy or institutional cost sharing is not in plan-level data, so estimates for them would mislead.
18. "Expensive drug" for the seed = estimated patient cost >= $50/month on their plan. It is the patient's cost, not the drug's list price (on copay plans even a $500 drug shows a $47 copay).
16. "Cheaper" alternatives must cost the patient strictly less; ties (same copay tier) are not suggestions.
15. Estimates ignore: deductible, coverage phases / the 2026 $2,100 out-of-pocket cap, manufacturer discount program, low-income subsidy, mail-order/90-day pricing, pharmacy dispensing fees.
11. A fuzzy (RxNav approximate) match can pick a near-miss drug, so responses always echo the matched RxNorm name for a human to verify.

## Known issues / not done
- Insulin: 2026 insulin cost sharing has its own file (lesser of $35 copay / 25% rules) that we do not load, so
  insulin estimates use the ordinary tier cost share and may be overstated.
- Cost estimates assume a typical fill quantity, not the patient's actual dose (see Task 4). `Patient.meds[].dose` is free text and is not parsed.
- Dual-eligible / low-income-subsidy members pay LIS copays instead of plan cost sharing; not modeled (seed patients avoid SNP plans).
- **Alternatives are not clinically validated** (see Task 5): they need pharmacist review before real use; the class allowlist is a starting point.
- Insulins and inhalers get no alternatives (unit / device / dose-conversion differences); brand -> generic still works for them.
- 11% of formulary drugs have no ATC class, so they never get (or appear as) alternatives.
- Only the schema init in `openDb()` (read-write) creates tables; an old DB file opened read-only will lack newer tables until a write-mode open has run.
- Excluded-drug and indication-based coverage files are not loaded (only relevant to enhanced plans / niche cases).
