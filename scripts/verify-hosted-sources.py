"""Verify the exported demo against the original CMS files and their live catalog URLs."""
import csv
import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data/raw/hosted-demo'

def main():
    export = json.loads((OUT / 'export.json').read_text())
    with urllib.request.urlopen('https://data.cms.gov/data.json', timeout=60) as response:
        catalog = json.load(response)
    urls = {d.get('downloadURL') for ds in catalog['dataset'] for d in ds.get('distribution', [])}
    manifests = json.loads((ROOT / 'data/raw/bootstrap-releases.json').read_text())
    verified = []
    for release in manifests:
        version = release['dataVersion']
        assert release['source'] in urls, f'{version} missing from official CMS catalog'
        archive = ROOT / 'data/raw' / Path(release['filePath']).name
        with archive.open('rb') as file:
            actual_hash = hashlib.file_digest(file, 'sha256').hexdigest()
        assert actual_hash == release['fileHash'], f'{version}: archive hash mismatch'
        extracted = ROOT / 'data/raw' / f'extract-{actual_hash[:16]}'
        expected = { (e['formularyId'], e['rxcui']): e['rows'] for e in export['evidence'] if e['version'] == version }
        actual = {key: [] for key in expected}
        source_file = next(extracted.rglob('basic*.txt'))
        def number(value, integer=False):
            return (int(value) if integer else float(value)) if value.strip() else None
        with source_file.open(encoding='latin-1', newline='') as file:
            for raw in csv.DictReader(file, delimiter='|', quoting=csv.QUOTE_NONE):
                row = {k.lower(): v.strip() for k,v in raw.items()}
                key = row['formulary_id'], row['rxcui']
                if key not in actual: continue
                actual[key].append({ 'ndc': row['ndc'], 'tier': number(row['tier_level_value'], True),
                    'prior_authorization': row['prior_authorization_yn']=='Y', 'step_therapy': row['step_therapy_yn']=='Y',
                    'quantity_limit': row['quantity_limit_yn']=='Y', 'quantity_limit_amount': number(row['quantity_limit_amount']),
                    'quantity_limit_days': number(row['quantity_limit_days'], True) })
        for key, rows in expected.items():
            assert sorted(actual[key],key=lambda r:r['ndc']) == rows, f'{version}: raw formulary mismatch {key}'
        expected_plans = {(p['contract_id'],p['plan_id'],p['segment_id']):p for p in export['plans'] if p['data_version']==version}
        found = set()
        with next(extracted.rglob('plan*.txt')).open(encoding='latin-1',newline='') as file:
            for raw in csv.DictReader(file,delimiter='|',quoting=csv.QUOTE_NONE):
                row = {k.lower():v.strip() for k,v in raw.items()}
                key = row['contract_id'],row['plan_id'],row['segment_id']
                if key not in expected_plans: continue
                p = expected_plans[key]
                for col in ['contract_name','plan_name','formulary_id']:
                    assert row[col] == p[col], f'{version}: plan mismatch {key} {col}'
                found.add(key)
        assert found == set(expected_plans), f'{version}: missing source plan'
        verified.append({'id':version,'source_url':release['source'],'sha256':actual_hash,
            'release_date':release['releaseDate'],'verified_at':datetime.now(timezone.utc).isoformat(),
            'evidence':{'catalog':'https://data.cms.gov/data.json','plans':list(expected_plans.values()),
                'formularyComparisons':[e for e in export['evidence'] if e['version']==version],
                'pricingNote':'September monthly PUF has no pricing; estimates reuse Q2 pricing and are not live quotes.',
                'patientNote':'All patient identities and plan enrollments are synthetic.'}})
        print(f'{version}: archive SHA-256, {len(found)} plans, {len(expected)} drug/formulary checks verified',flush=True)
    (OUT / 'verified-sources.json').write_text(json.dumps(verified,indent=2))

if __name__ == '__main__': main()
