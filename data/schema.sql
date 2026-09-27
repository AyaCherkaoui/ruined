-- Portable schema (DuckDB now, Postgres/Tiger Data later via DATABASE_URL).
-- Keep types to the common subset: VARCHAR / INTEGER / DOUBLE PRECISION / BOOLEAN / TIMESTAMP.
-- Every SPUF-derived table carries data_version so v1 (real CMS data) and v2 (synthetic
-- change-tracker copy) can live side by side.

CREATE TABLE IF NOT EXISTS data_versions (
  id           VARCHAR PRIMARY KEY,  -- e.g. 'v1', 'v2-cms' -- matches the data_version column below
  source       VARCHAR NOT NULL,
  release_date DATE,
  file_hash    VARCHAR,
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
-- Minimal patient model (see DATA_MODEL.md). A patient is just an id and a name --
-- nothing else about the patient, ever. Plan enrollment and prescriptions are
-- separate tables so nothing clinical or demographic hangs off `patients` itself.
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctors (
  id        VARCHAR PRIMARY KEY,
  full_name VARCHAR NOT NULL,
  phone     VARCHAR
);

CREATE TABLE IF NOT EXISTS patients (
  id        VARCHAR PRIMARY KEY,
  full_name VARCHAR NOT NULL
);

-- A patient's current Part D plan enrollment. Version-independent: which plan the
-- patient is on doesn't change when a new formulary release is loaded, only what
-- that plan's formulary happens to say -- so this table carries no data_version.
CREATE TABLE IF NOT EXISTS patient_coverage (
  patient_id  VARCHAR PRIMARY KEY,
  contract_id VARCHAR NOT NULL,
  plan_id     VARCHAR NOT NULL,
  segment_id  VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id         VARCHAR PRIMARY KEY,
  patient_id VARCHAR NOT NULL,
  doctor_id  VARCHAR NOT NULL,
  rxcui      VARCHAR NOT NULL,
  started_at TIMESTAMP NOT NULL
);

-- ---------------------------------------------------------------------------------
-- Change tracker (lib/pipeline/detectChanges.ts): every ADVERSE formulary change
-- between two loaded data versions, for a given (formulary_id, rxcui) pair. One row
-- per change_type, so a drug that both loses tier and gains a PA in the same release
-- produces two rows, not one row with an ambiguous "primary" type.
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coverage_changes (
  id           VARCHAR PRIMARY KEY,
  from_version VARCHAR NOT NULL,
  to_version   VARCHAR NOT NULL,
  formulary_id VARCHAR NOT NULL,
  rxcui        VARCHAR NOT NULL,
  change_type  VARCHAR NOT NULL,  -- 'removed' | 'tier_increase' | 'new_prior_auth' | 'new_step_therapy' | 'new_quantity_limit'
  old_tier     INTEGER,
  new_tier     INTEGER,
  old_pa       BOOLEAN NOT NULL,
  new_pa       BOOLEAN NOT NULL,
  old_st       BOOLEAN NOT NULL,
  new_st       BOOLEAN NOT NULL,
  old_ql       BOOLEAN NOT NULL,
  new_ql       BOOLEAN NOT NULL,
  detected_at  TIMESTAMP NOT NULL
);

-- One row per (coverage_change, prescription) that the change actually hits: the
-- patient's plan uses the affected formulary. Costs and the suggested switch come
-- from checkCoverage/findAlternatives (lib/pipeline/matchPrescriptions.ts), never
-- recomputed ad hoc. `status` is workflow state a doctor could set later (no endpoint
-- writes anything but 'new' yet -- see PROGRESS.md).
CREATE TABLE IF NOT EXISTS patient_alerts (
  id                     VARCHAR PRIMARY KEY,
  change_id              VARCHAR NOT NULL,
  patient_id             VARCHAR NOT NULL,
  prescription_id        VARCHAR NOT NULL,
  contract_id            VARCHAR NOT NULL,
  plan_id                VARCHAR NOT NULL,
  old_monthly_cost       DOUBLE PRECISION,
  new_monthly_cost       DOUBLE PRECISION,
  best_alternative_rxcui VARCHAR,
  best_alternative_cost  DOUBLE PRECISION,
  status                 VARCHAR NOT NULL,
  created_at             TIMESTAMP NOT NULL
);

-- Saved review choice, separate from the pipeline's ranked recommendation.
-- Recording a decision does not issue or change a prescription.
CREATE TABLE IF NOT EXISTS patient_alert_decisions (
  alert_id VARCHAR PRIMARY KEY,
  rxcui VARCHAR NOT NULL,
  drug_name VARCHAR NOT NULL,
  monthly_cost DOUBLE PRECISION,
  saved_at TIMESTAMP NOT NULL
);
