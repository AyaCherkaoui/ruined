"""Rebuild the legacy CMS baseline into one explicit database; never chooses a stale zip."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
TITLES = [
    "Quarterly Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information",
    "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information",
]


def download(url, archive):
    """Resume interrupted large public ZIPs; never promote a partial response."""
    partial = archive.with_suffix(".zip.part")
    for attempt in range(5):
        offset = partial.stat().st_size if partial.exists() else 0
        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                resume = offset > 0 and response.status == 206
                if resume and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise ValueError("Server returned an unexpected byte range")
                expected = int(response.headers.get("Content-Length", "0"))
                received = 0
                with partial.open("ab" if resume else "wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
                        received += len(chunk)
                if expected and received != expected:
                    raise OSError("Truncated download")
            # Verify a real ZIP before publishing its filename.
            import zipfile
            with zipfile.ZipFile(partial) as zipped:
                if not zipped.namelist():
                    raise ValueError("Empty CMS archive")
            partial.replace(archive)
            return
        except (OSError, ValueError) as error:
            if attempt == 4:
                raise
            print(f"Download retry {attempt + 1}: {type(error).__name__}", flush=True)
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(ROOT / "data/scenario.duckdb"))
    parser.add_argument("--catalog", help="Saved CMS catalog (full catalog or selected dataset array)")
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    db = Path(args.db).resolve()
    db.parent.mkdir(parents=True, exist_ok=True)
    raw = ROOT / "data/raw"
    raw.mkdir(exist_ok=True)
    if args.catalog:
        catalog = json.loads(Path(args.catalog).read_text())
    else:
        with urllib.request.urlopen("https://data.cms.gov/data.json", timeout=120) as response:
            catalog = json.load(response)
    datasets = catalog if isinstance(catalog, list) else catalog["dataset"]
    manifest = []
    for title, version, loader in zip(TITLES, ["v1", "v2-cms"], ["load_spuf.py", "load_puf_monthly.py"]):
        dataset = next(d for d in datasets if d["title"] == title)
        release = max((d for d in dataset["distribution"] if d.get("downloadURL", "").endswith(".zip")), key=lambda d: d["temporal"])
        url = release["downloadURL"]
        archive = raw / url.rsplit("/", 1)[-1]
        if not archive.exists():
            print(f"Downloading {url}", flush=True)
            download(url, archive)
        with archive.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest.append(dict(dataVersion=version, source=url, releaseDate=release["temporal"].split("/")[0], filePath=str(archive), fileHash=digest))
        print(f"{version}: {archive.name} sha256={digest}", flush=True)
        if not args.download_only:
            subprocess.run([sys.executable, str(ROOT / "scripts" / loader), "--zip", str(archive), "--work", str(raw / f"extract-{digest[:16]}"), "--db", str(db), "--data-version", version], cwd=ROOT, check=True)
    manifest_path = raw / "bootstrap-releases.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    if not args.download_only:
        env = dict(os.environ, RUINED_DB=str(db))
        subprocess.run(["node", "--import", "tsx", "scripts/verify-bootstrap.ts", str(manifest_path)], cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    main()
