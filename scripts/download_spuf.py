#!/usr/bin/env python3
"""Download the latest QUARTERLY CMS Part D SPUF (formulary, pharmacy network, pricing).

The cms.gov landing page is a JS app that redirects to data.cms.gov, so we read the
public data.json catalog instead. Also grabs the record layout + methodology PDFs.

    .venv/bin/python scripts/download_spuf.py [--dry-run]
"""
import argparse
import json
import os
import urllib.request
from pathlib import Path

CATALOG = "https://data.cms.gov/data.json"
TITLE = "Quarterly Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information"
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
    # temporal looks like "2026-04-01/2026-06-30"; newest quarter = latest end date
    latest = max(ds["distribution"], key=lambda d: d["temporal"].split("/")[-1])
    zip_url = latest["downloadURL"]
    docs = {"record layout": ds["describedBy"], "methodology": ds["references"][0]}
    print("latest quarter:", latest["temporal"], zip_url)
    print("docs:", docs)
    if args.dry_run:
        return
    RAW.mkdir(parents=True, exist_ok=True)
    fetch(zip_url, RAW / os.path.basename(zip_url))
    for url in docs.values():
        fetch(url, RAW / os.path.basename(url))


if __name__ == "__main__":
    main()
