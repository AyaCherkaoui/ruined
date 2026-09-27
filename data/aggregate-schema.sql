-- Isolated additive storage; applied only by the aggregate pipeline.
CREATE TABLE IF NOT EXISTS source_runs (
  id VARCHAR PRIMARY KEY, source VARCHAR NOT NULL, captured_at VARCHAR NOT NULL,
  status VARCHAR NOT NULL, fingerprint VARCHAR NOT NULL, payload VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS coverage_observations (
  id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL, observation_key VARCHAR NOT NULL,
  payload VARCHAR NOT NULL, UNIQUE(run_id, observation_key)
);
CREATE TABLE IF NOT EXISTS coverage_change_facts (
  id VARCHAR PRIMARY KEY, from_run VARCHAR NOT NULL, to_run VARCHAR NOT NULL,
  payload VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS coverage_comparisons (
  to_run VARCHAR PRIMARY KEY, from_run VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS prescriber_drug_volume (
  source_year INTEGER NOT NULL, npi VARCHAR NOT NULL, drug VARCHAR NOT NULL,
  payload VARCHAR NOT NULL, PRIMARY KEY(source_year, npi, drug)
);
CREATE TABLE IF NOT EXISTS provider_plan_acceptance (
  npi VARCHAR NOT NULL, plan_key VARCHAR NOT NULL, source VARCHAR NOT NULL,
  PRIMARY KEY(npi, plan_key)
);
CREATE TABLE IF NOT EXISTS doctor_impacts (
  id VARCHAR PRIMARY KEY, change_id VARCHAR NOT NULL, payload VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_executions (
  run_id VARCHAR PRIMARY KEY, input_hash VARCHAR NOT NULL, payload VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_outbox (
  id VARCHAR PRIMARY KEY, impact_id VARCHAR NOT NULL, status VARCHAR NOT NULL,
  attempts INTEGER NOT NULL, payload VARCHAR NOT NULL
);
