#!/usr/bin/env python3
"""Download the latest MONTHLY CMS Part D formulary/pharmacy-network public use file
(newer than our quarterly SPUF -- see download_spuf.py), plus its record layout PDFs.

Unlike the quarterly SPUF, the monthly file has NO pricing file (see PROGRESS.md task 1):
load_puf_monthly.py reuses v1 pricing for the drugs it prices.

    .venv/bin/python scripts/download_puf_monthly.py [--dry-run]
"""
import argparse
import json
import os
import urllib.request
from pathlib import Path

CATALOG = "https://data.cms.gov/data.json"
TITLE = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information"
RAW = Path(__file__).resolve().parent.parent / "data/raw"


def fetch(url, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"already have {dest.name} ({dest.stat().st_size:,} bytes)")
        return
    print(f"downloading {url}")
    urllib.request.urlretrieve(url, dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    with urllib.request.urlopen(CATALOG) as r:
        catalog = json.load(r)
    ds = next(d for d in catalog["dataset"] if d["title"] == TITLE)
    # temporal looks like "2026-09-01/2026-09-30"; newest month = latest end date
    latest = max(ds["distribution"], key=lambda d: d["temporal"].split("/")[-1])
    zip_url = latest["downloadURL"]
    docs = {"record layout": ds["describedBy"], "methodology": ds["references"][0]}
    print("latest month:", latest["temporal"], zip_url)
    print("docs:", docs)
    if args.dry_run:
        return
    RAW.mkdir(parents=True, exist_ok=True)
    fetch(zip_url, RAW / os.path.basename(zip_url))
    for url in docs.values():
        fetch(url, RAW / os.path.basename(url))


if __name__ == "__main__":
    main()
