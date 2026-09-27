#!/usr/bin/env python3
"""Load the CMS Quarterly Part D SPUF into DuckDB, filtered to Georgia plans.

    .venv/bin/python scripts/load_spuf.py                       # loads data_version 'v1'
    .venv/bin/python scripts/load_spuf.py --data-version v1 --db data/ruined.duckdb

Reads the raw SPUF zip (data/raw/SPUF_*.zip, gitignored), extracts only the nested
files it needs (skips the ~2.4 GB pharmacy network parts) and loads:
plans, formulary, beneficiary_cost, pricing  -- all tagged with data_version.

Georgia scope (see SPUFRecordLayout-2026.pdf):
  H (local MA)    STATE = 'GA'
  R (regional MA) MA_REGION_CODE = 8   (Georgia + South Carolina)
  S (PDP)         PDP_REGION_CODE = 10 (Georgia)
Plans with PLAN_SUPPRESSED_YN = 'Y' are dropped (they have no rows in other files).
"""
import argparse
import glob
import os
import sys
import time
import zipfile
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
NEEDED = {
    # key: substring of the nested zip name inside the outer SPUF zip
    "plan": "plan information",
    "formulary": "basic drugs formulary file",
    "beneficiary_cost": "beneficiary cost file",
    "pricing": "pricing file",
}
READ_OPTS = "delim='|', header=true, all_varchar=true, quote='', escape='', encoding='latin-1'"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def extract(outer_zip: Path, work: Path):
    """Extract the nested zips we need from the outer SPUF zip into `work`."""
    work.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(outer_zip) as outer:
        for name in outer.namelist():
            low = Path(name).name.lower()
            if not low.endswith(".zip") or "sample" in low:
                continue
            if not any(low.startswith(key) for key in NEEDED.values()):
                continue
            target = work / Path(name).stem
            if list(target.glob("*.txt")):
                continue
            log(f"extracting {name}")
            outer.extract(name, work)  # nested zip must be on disk to be seekable
            with zipfile.ZipFile(work / name) as inner:
                inner.extractall(target)
            (work / name).unlink()


def find_txt(work: Path, key: str) -> str:
    hits = [p for p in glob.glob(str(work / "**" / "*.txt"), recursive=True)
            if os.path.basename(p).lower().startswith(NEEDED[key]) and "sample" not in p.lower()]
    if len(hits) != 1:
        sys.exit(f"expected exactly one {key} file under {work}, found {hits}")
    return hits[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default=str(ROOT / "data/raw/SPUF_2026_20260701.zip"))
    ap.add_argument("--work", default=str(ROOT / "data/raw/extracted"))
    ap.add_argument("--db", default=os.environ.get("RUINED_DB", str(ROOT / "data/scenario.duckdb")))
    ap.add_argument("--data-version", default="v1")
    ap.add_argument("--pricing-days", default="30,90", help="comma list of DAYS_SUPPLY values to keep")
    args = ap.parse_args()

    zip_path, work = Path(args.zip), Path(args.work)
    if not any(work.glob("**/*.txt")):
        if not zip_path.exists():
            sys.exit(f"{zip_path} not found; download it first (see PROGRESS.md task 1)")
        extract(zip_path, work)
    files = {k: find_txt(work, k) for k in NEEDED}
    for k, v in files.items():
        log(f"{k}: {os.path.basename(v)}")

    dv = args.data_version
    days = ",".join(str(int(d)) for d in args.pricing_days.split(","))
    con = duckdb.connect(args.db)
    con.execute((ROOT / "data/schema.sql").read_text())

    # Idempotent reload of this data_version. (data_versions bookkeeping is now owned by
    # lib/pipeline/ingestRelease.ts -- see PROGRESS.md task 2 -- not written here.)
    for t in ("plans", "formulary", "beneficiary_cost", "pricing"):
        con.execute(f"DELETE FROM {t} WHERE data_version = ?", [dv])

    # ---- plans ------------------------------------------------------------------
    log("loading plans (Georgia only)")
    con.execute(f"CREATE OR REPLACE TEMP TABLE plan_raw AS SELECT * FROM read_csv('{files['plan']}', {READ_OPTS})")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE ga_plan_rows AS
        SELECT * FROM plan_raw
        WHERE trim(plan_suppressed_yn) <> 'Y' AND (
              (substr(contract_id,1,1) = 'H' AND trim(state) = 'GA')
           OR (substr(contract_id,1,1) = 'R' AND trim(ma_region_code) = '8')
           OR (substr(contract_id,1,1) = 'S' AND trim(pdp_region_code) = '10'))
    """)
    con.execute("""
        INSERT INTO plans
        SELECT ?, contract_id, plan_id, segment_id,
               min(contract_name), min(plan_name), min(formulary_id),
               min(CAST(nullif(trim(premium), '') AS DOUBLE)),
               min(CAST(nullif(trim(deductible), '') AS DOUBLE)),
               min(trim(snp)), min(substr(contract_id,1,1)), 'GA',
               count(DISTINCT nullif(trim(county_code), ''))
        FROM ga_plan_rows GROUP BY contract_id, plan_id, segment_id
    """, [dv])
    n_plans = con.execute("SELECT count(*) FROM plans WHERE data_version = ?", [dv]).fetchone()[0]
    dup = con.execute("""SELECT count(*) FROM (SELECT 1 FROM ga_plan_rows GROUP BY contract_id, plan_id, segment_id
                         HAVING count(DISTINCT formulary_id) > 1)""").fetchone()[0]
    assert dup == 0, "a plan maps to more than one formulary id"
    log(f"  plans: {n_plans}")
    con.execute("CREATE OR REPLACE TEMP TABLE ga_plans AS SELECT contract_id, plan_id, segment_id, formulary_id FROM plans WHERE data_version = ?", [dv])

    # ---- formulary --------------------------------------------------------------
    log("loading formulary (formularies used by Georgia plans)")
    con.execute(f"""
        INSERT INTO formulary
        SELECT ?, f.formulary_id, f.formulary_version, f.contract_year, trim(f.rxcui), f.ndc,
               CAST(nullif(trim(f.tier_level_value), '') AS INTEGER),
               trim(f.quantity_limit_yn) = 'Y',
               CAST(nullif(trim(f.quantity_limit_amount), '') AS DOUBLE),
               CAST(nullif(trim(f.quantity_limit_days), '') AS INTEGER),
               trim(f.prior_authorization_yn) = 'Y',
               trim(f.step_therapy_yn) = 'Y',
               trim(f.selected_drug_yn) = 'Y'
        FROM read_csv('{files['formulary']}', {READ_OPTS}) f
        WHERE f.formulary_id IN (SELECT DISTINCT formulary_id FROM ga_plans)
    """, [dv])
    log(f"  formulary rows: {con.execute('SELECT count(*) FROM formulary WHERE data_version = ?', [dv]).fetchone()[0]:,}")

    # ---- beneficiary_cost -------------------------------------------------------
    log("loading beneficiary_cost")
    num = lambda c: f"CAST(nullif(trim(b.{c}), '') AS DOUBLE)"
    ints = lambda c: f"CAST(nullif(trim(b.{c}), '') AS INTEGER)"
    cols = []
    for p in ("pref", "nonpref", "mail_pref", "mail_nonpref"):
        cols += [ints(f"cost_type_{p}"), num(f"cost_amt_{p}"), num(f"cost_min_amt_{p}"), num(f"cost_max_amt_{p}")]
    con.execute(f"""
        INSERT INTO beneficiary_cost
        SELECT ?, b.contract_id, b.plan_id, b.segment_id,
               {ints('coverage_level')}, {ints('tier')}, {ints('days_supply')},
               {', '.join(cols)},
               trim(b.tier_specialty_yn) = 'Y', trim(b.ded_applies_yn) = 'Y'
        FROM read_csv('{files['beneficiary_cost']}', {READ_OPTS}) b
        JOIN ga_plans g USING (contract_id, plan_id, segment_id)
    """, [dv])
    log(f"  beneficiary_cost rows: {con.execute('SELECT count(*) FROM beneficiary_cost WHERE data_version = ?', [dv]).fetchone()[0]:,}")

    # ---- pricing (2 GB raw; stream + filter) ------------------------------------
    log(f"loading pricing (days_supply in {days}) -- this is the slow one")
    con.execute(f"""
        INSERT INTO pricing
        SELECT ?, p.contract_id, p.plan_id, p.segment_id, p.ndc,
               CAST(p.days_supply AS INTEGER), CAST(p.unit_cost AS DOUBLE)
        FROM read_csv('{files['pricing']}', {READ_OPTS}) p
        JOIN ga_plans g USING (contract_id, plan_id, segment_id)
        WHERE CAST(p.days_supply AS INTEGER) IN ({days})
          AND nullif(trim(p.unit_cost), '') IS NOT NULL
    """, [dv])
    log(f"  pricing rows: {con.execute('SELECT count(*) FROM pricing WHERE data_version = ?', [dv]).fetchone()[0]:,}")

    # ---- indexes on join keys -----------------------------------------------------
    log("creating indexes")
    for ddl in (
        "CREATE INDEX IF NOT EXISTS idx_plans_key ON plans (contract_id, plan_id, segment_id)",
        "CREATE INDEX IF NOT EXISTS idx_plans_formulary ON plans (formulary_id)",
        "CREATE INDEX IF NOT EXISTS idx_formulary_key ON formulary (formulary_id, rxcui)",
        "CREATE INDEX IF NOT EXISTS idx_formulary_rxcui ON formulary (rxcui)",
        "CREATE INDEX IF NOT EXISTS idx_bc_key ON beneficiary_cost (contract_id, plan_id, segment_id, tier)",
        "CREATE INDEX IF NOT EXISTS idx_pricing_key ON pricing (contract_id, plan_id, segment_id, ndc)",
    ):
        con.execute(ddl)

    log("done")
    for t in ("plans", "formulary", "beneficiary_cost", "pricing"):
        print(f"  {t:18s} {con.execute(f'SELECT count(*) FROM {t} WHERE data_version = ?', [dv]).fetchone()[0]:>12,}")
    con.close()


if __name__ == "__main__":
    main()
