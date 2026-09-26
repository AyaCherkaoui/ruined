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
