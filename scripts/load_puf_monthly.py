#!/usr/bin/env python3
"""Load the CMS MONTHLY Part D formulary/pharmacy-network PUF into DuckDB as data_version
'v2-cms', filtered to Georgia plans -- the real (not synthetic) "what changed" comparison
point for v1 (see PROGRESS.md task 1).

    .venv/bin/python scripts/load_puf_monthly.py                      # loads data_version 'v2-cms'
    .venv/bin/python scripts/load_puf_monthly.py --zip data/raw/2026_20260916.zip

Loads: plans, formulary, beneficiary_cost -- same as load_spuf.py. This monthly PUF has
NO pricing file (confirmed against PUFRecordLayout-2026.pdf: no PRICING FILE section), so
pricing for 'v2-cms' is a straight copy of v1's pricing rows (same NDCs are priced the same;
an NDC that only appears in the new formulary has no price and prices as null, same as any
other unpriced NDC -- see lib/coverage.ts). This is logged below and in PROGRESS.md.
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
    "plan": "plan information",
    "formulary": "basic drugs formulary file",
    "beneficiary_cost": "beneficiary cost file",
}
READ_OPTS = "delim='|', header=true, all_varchar=true, quote='', escape='', encoding='latin-1'"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def extract(outer_zip: Path, work: Path):
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
            outer.extract(name, work)
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
    ap.add_argument("--zip", default=str(ROOT / "data/raw/2026_20260916.zip"))
    ap.add_argument("--work", default=str(ROOT / "data/raw/extracted_monthly"))
    ap.add_argument("--db", default=os.environ.get("RUINED_DB", str(ROOT / "data/scenario.duckdb")))
    ap.add_argument("--data-version", default="v2-cms")
    ap.add_argument("--pricing-source", default="v1", help="data_version to copy pricing rows from")
    args = ap.parse_args()

    zip_path, work = Path(args.zip), Path(args.work)
    if not any(work.glob("**/*.txt")):
        if not zip_path.exists():
            sys.exit(f"{zip_path} not found; download it first: scripts/download_puf_monthly.py")
        extract(zip_path, work)
    files = {k: find_txt(work, k) for k in NEEDED}
    for k, v in files.items():
        log(f"{k}: {os.path.basename(v)}")

    dv = args.data_version
    con = duckdb.connect(args.db)
    con.execute((ROOT / "data/schema.sql").read_text())

    # data_versions bookkeeping is now owned by lib/pipeline/ingestRelease.ts (PROGRESS.md task 2).
    for t in ("plans", "formulary", "beneficiary_cost", "pricing"):
        con.execute(f"DELETE FROM {t} WHERE data_version = ?", [dv])

    # ---- plans (same Georgia rule as load_spuf.py) -------------------------------
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
    log(f"  plans: {n_plans}")
    con.execute("CREATE OR REPLACE TEMP TABLE ga_plans AS SELECT contract_id, plan_id, segment_id, formulary_id FROM plans WHERE data_version = ?", [dv])

    # ---- formulary -----------------------------------------------------------------
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

    # ---- beneficiary_cost ------------------------------------------------------------
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

    # ---- pricing: NOT in this file -- reuse the quarterly pricing (see module docstring) ------
    src = args.pricing_source
    log(f"no pricing file in the monthly PUF -- copying pricing from data_version '{src}'")
    con.execute(f"""
        INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost)
        SELECT ?, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost
        FROM pricing WHERE data_version = ?
    """, [dv, src])
    log(f"  pricing rows (copied from {src}): {con.execute('SELECT count(*) FROM pricing WHERE data_version = ?', [dv]).fetchone()[0]:,}")

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
