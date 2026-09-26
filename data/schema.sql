-- Portable schema (DuckDB now, Postgres/Tiger Data later via DATABASE_URL).
-- Keep types to the common subset: VARCHAR / INTEGER / DOUBLE PRECISION / BOOLEAN / TIMESTAMP.
-- Every SPUF-derived table carries data_version so v1 (real CMS data) and v2 (synthetic
-- change-tracker copy) can live side by side.

CREATE TABLE IF NOT EXISTS data_versions (
  data_version VARCHAR PRIMARY KEY,
  source       VARCHAR NOT NULL,
  loaded_at    TIMESTAMP NOT NULL
);

-- One row per plan (CONTRACT_ID, PLAN_ID, SEGMENT_ID). The raw plan file has one row per
-- county for local MA plans; we collapse those to the plan.
CREATE TABLE IF NOT EXISTS plans (
  data_version   VARCHAR NOT NULL,
  contract_id    VARCHAR NOT NULL,
  plan_id        VARCHAR NOT NULL,
  segment_id     VARCHAR NOT NULL,
  contract_name  VARCHAR,
  plan_name      VARCHAR,
  formulary_id   VARCHAR NOT NULL,
  premium        DOUBLE PRECISION,
  deductible     DOUBLE PRECISION,
  snp            VARCHAR,
  plan_type      VARCHAR,          -- H = local MA, R = regional MA, S = stand-alone PDP
  state          VARCHAR,          -- 'GA' (from STATE for H plans, derived from region for R/S)
  ga_county_count INTEGER          -- number of Georgia counties in the raw plan file (H plans)
);

-- Formulary is per FORMULARY_ID (shared by many plans) and per NDC. RXCUI -> many NDCs.
CREATE TABLE IF NOT EXISTS formulary (
  data_version         VARCHAR NOT NULL,
  formulary_id         VARCHAR NOT NULL,
  formulary_version    VARCHAR,
  contract_year        VARCHAR,
  rxcui                VARCHAR NOT NULL,
  ndc                  VARCHAR NOT NULL,
  tier                 INTEGER,
  quantity_limit       BOOLEAN NOT NULL,
  quantity_limit_amount DOUBLE PRECISION,
  quantity_limit_days  INTEGER,
  prior_authorization  BOOLEAN NOT NULL,
  step_therapy         BOOLEAN NOT NULL,
  selected_drug        BOOLEAN NOT NULL
);

-- Cost sharing per plan / coverage level / tier / days supply.
-- COST_TYPE_*: 0 = not offered, 1 = copay ($), 2 = coinsurance (fraction, .25 = 25%).
CREATE TABLE IF NOT EXISTS beneficiary_cost (
  data_version            VARCHAR NOT NULL,
  contract_id             VARCHAR NOT NULL,
  plan_id                 VARCHAR NOT NULL,
  segment_id              VARCHAR NOT NULL,
  coverage_level          INTEGER NOT NULL,  -- 0 pre-deductible, 1 initial coverage, 3 catastrophic
  tier                    INTEGER NOT NULL,
  days_supply             INTEGER NOT NULL,  -- 1 = 30 days, 2 = 90 days, 3 = other, 4 = 60 days
  cost_type_pref          INTEGER,
  cost_amt_pref           DOUBLE PRECISION,
  cost_min_amt_pref       DOUBLE PRECISION,
  cost_max_amt_pref       DOUBLE PRECISION,
  cost_type_nonpref       INTEGER,
  cost_amt_nonpref        DOUBLE PRECISION,
  cost_min_amt_nonpref    DOUBLE PRECISION,
  cost_max_amt_nonpref    DOUBLE PRECISION,
  cost_type_mail_pref     INTEGER,
  cost_amt_mail_pref      DOUBLE PRECISION,
  cost_min_amt_mail_pref  DOUBLE PRECISION,
  cost_max_amt_mail_pref  DOUBLE PRECISION,
  cost_type_mail_nonpref  INTEGER,
  cost_amt_mail_nonpref   DOUBLE PRECISION,
  cost_min_amt_mail_nonpref DOUBLE PRECISION,
  cost_max_amt_mail_nonpref DOUBLE PRECISION,
  tier_specialty          BOOLEAN,
  ded_applies             BOOLEAN
);

-- Average per-unit cost (e.g. per pill / per mL) at in-area retail pharmacies.
CREATE TABLE IF NOT EXISTS pricing (
  data_version VARCHAR NOT NULL,
  contract_id  VARCHAR NOT NULL,
  plan_id      VARCHAR NOT NULL,
  segment_id   VARCHAR NOT NULL,
  ndc          VARCHAR NOT NULL,
  days_supply  INTEGER NOT NULL,  -- 30, 60 or 90
  unit_cost    DOUBLE PRECISION NOT NULL
);

-- ---------------------------------------------------------------------------------
-- Drug cache (filled from RxNav / RxClass; see lib/drugs.ts, scripts/warm-drug-cache.ts)
-- ---------------------------------------------------------------------------------
-- One row per RxNorm concept we have looked at. Formulary RXCUIs are SCD (generic) / SBD (brand).
CREATE TABLE IF NOT EXISTS drugs (
  rxcui             VARCHAR PRIMARY KEY,
  name              VARCHAR NOT NULL,
  tty               VARCHAR,            -- RxNorm term type: SCD, SBD, IN, BN, ...
  ingredient_rxcui  VARCHAR,            -- IN rxcui, or MIN rxcui for multi-ingredient drugs
  ingredient_name   VARCHAR,
  class_id          VARCHAR,            -- ATC level-4 class from RxClass, e.g. C10AA
  class_name        VARCHAR,
  class_type        VARCHAR,            -- 'ATC1-4'
  dose_form_group   VARCHAR,            -- RxNorm DFG route family: 'Oral Product', 'Injectable Product', ...
  generic_rxcui     VARCHAR,            -- for a brand (SBD): the SCD it is a tradename of
  fetched_at        TIMESTAMP NOT NULL
);

-- Free-text name a user typed -> rxcui (so repeated lookups never hit the network).
CREATE TABLE IF NOT EXISTS drug_aliases (
  alias  VARCHAR PRIMARY KEY,
  rxcui  VARCHAR NOT NULL
);

-- ---------------------------------------------------------------------------------
-- Synthetic patients (seeded by scripts/seed-patients.ts). No real patient data.
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patients (
  id          VARCHAR PRIMARY KEY,
  name        VARCHAR NOT NULL,
  age         INTEGER NOT NULL,
  language    VARCHAR NOT NULL,
  contract_id VARCHAR NOT NULL,
  plan_id     VARCHAR NOT NULL,
  segment_id  VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS patient_meds (
  patient_id VARCHAR NOT NULL,
  rxcui      VARCHAR NOT NULL,
  drug_name  VARCHAR NOT NULL,
  dose       VARCHAR NOT NULL
);

-- ---------------------------------------------------------------------------------
-- Alert workflow state (PatientAlert.status). Alerts themselves are computed fresh
-- from the loaded data on every request (lib/patientAlerts.ts), not stored; this table
-- holds only the doctor's action on each alert id. A missing row means status 'new'.
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_status (
  alert_id    VARCHAR PRIMARY KEY,
  status      VARCHAR NOT NULL,
  switched_to VARCHAR,
  created_at  TIMESTAMP NOT NULL,
  updated_at  TIMESTAMP NOT NULL
);
