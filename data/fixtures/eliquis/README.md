# Pipeline fixtures

`baseline.json`, `adverse.json`, `restored.json`, `prescribers.jsonl`, and
`acceptance.json` are **entirely synthetic test inputs**, not captured Humana data.
HDEMO plans and zero-prefixed NPIs are placeholders. Their source release hash is
deliberately all zeros; ingestion adds the real SHA-256 of each fixture artifact.
All observations and derived changes retain `provenance: simulated`; impacts
carry `simulated_source` and `simulated_change` flags.

`humana-cms-plans.json` contains real CMS plan keys selected from the downloaded
2026 quarterly Georgia release: Humana Basic Rx and Humana Premier Rx. This is a
scope configuration, not a claim that they resolve in Humana's FHIR API. Export
validates these identities and the Humana name against each loaded release.

Real downloaded archives, captured HTTP pages, and databases belong in ignored
`data/raw/` and `data/*.duckdb`. Do not replace these synthetic fixtures with raw
national data or imply they are the real-baseline demo required by milestone 05.

## Real-baseline demo (milestone 05)

`real-baseline.json` is the redacted public CMS export; its manifest records the
source archive and normalized fixture hashes. It is replay data. The older
`baseline.json`, `adverse.json`, `restored.json`, prescriber, and acceptance files
remain synthetic unit fixtures. `npm run pipeline:e2e` derives explicitly simulated
changes from the real baseline. See `docs/pipeline-operations.md` for provenance
and complete offline commands.
