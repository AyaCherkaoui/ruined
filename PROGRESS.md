# PROGRESS

Backend-only build on the `backend` branch (local commits, no push). Every coverage decision
comes from our data + deterministic code, never an LLM.

## Status

| # | Task | Status |
|---|------|--------|
| 1 | Download latest quarterly CMS SPUF, read record layout | done |
| 2 | Python + DuckDB loader (Georgia only) | pending |
| 3 | Drug normalizer (RxNav / RxClass) + drugs cache | pending |
| 4 | checkCoverage + tests | pending |
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

## Assumptions log
1. "Latest quarterly" = Q2 2026 SPUF (2026-07-01 posting), not the newer monthly files.
2. Record layout PDF lives beside the dataset on data.cms.gov, not inside the zip.
3. Raw files are read as Latin-1.

## Known issues / not done
- (none yet)
