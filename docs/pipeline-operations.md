# Eliquis aggregate operations (milestones 05–08)

Update: the [demo runbook](demo-runbook.md) describes the subsequently added published
payload adapter for the existing `/api/alerts` API. The original milestones below
remain isolated commands; `demo:prepare` now publishes their proof for app consumption.

These commands run the isolated aggregate pipeline. The API contract remains a
proposed handoff: no API route, UI, patient record, or workflow state is added.
All commands run from the repository root. Install dependencies with `npm install`.

## 05: offline demo with a real baseline

```powershell
npm run pipeline:e2e
```

The command needs no network or existing database. It writes
`data/raw/eliquis-demo.json` (override with `--output PATH`) containing the
`eliquis-aggregate-v1` payload before and after reversal, source manifest,
redacted console preview, and verification counts. Two independent in-memory
databases produce identical output; each also replays the same IDs in place.
Expected counts: 3 source runs, 12 observations, 2 reciprocal change facts,
1 historical impact, and 0 active impacts after reversal. One console preview
is recorded, with **zero external messages sent**.

`data/fixtures/eliquis/real-baseline.json` is a public CMS monthly export captured
from the hashed September 2026 release for Humana plans S5884-135-000 and
S5884-156-000, with both Eliquis strengths. Its adjacent manifest preserves the
source URL, archive SHA-256, capture time, and fixture SHA-256 (UTF-8/LF). No
credential, local path, patient, or prescriber information is included.
The demo adds PA to the first plan's 5 mg observation, then removes it; both
snapshots are explicitly simulated. Their release hash identifies the real
baseline from which they were derived; raw artifact hashes identify their own
modified contents. The all-zero NPI, demo plan acceptance, and 184 annual claims
are synthetic. Neither the simulated change nor the claims count describes
actual affected beneficiaries. The baseline's effective date remains unknown.

## 06: daily command

Preview is the default. It validates and runs the complete pipeline against a
temporary copy of the selected database, or a new temporary database if none
exists. The target database is unchanged. Preview still writes immutable raw
artifacts and attempt summaries for inspection.

```powershell
npm run pipeline:daily -- --input data/fixtures/eliquis/real-baseline.json --run cms-baseline --year 2024
# Persist the validated run locally:
npm run pipeline:daily -- --input data/fixtures/eliquis/real-baseline.json --run cms-baseline --year 2024 --commit
```

The default target is `data/eliquis-daily.duckdb`; use `--db PATH` consistently.
Use `pipeline:eliquis load-prescribers` and `accept-plans` with this same database
to configure annual volumes and explicit signup acceptance before daily runs.
Without these inputs, matching legitimately returns zero impacts.

Acquisition can instead export from a locally staged, hashed CMS release:

```powershell
npm run pipeline:daily -- --source-db data/verified-scenario.duckdb --release v2-cms --plans data/fixtures/eliquis/humana-cms-plans.json --captured-at 2026-09-27T00:00:00.000Z --run cms-september --year 2024 --commit
```

CMS remains a **monthly release source**. This command does not claim to fetch
daily Humana coverage or automatically select/download a new CMS release.
Stage updates using the bootstrap/export commands in the pipeline guide. Replay
files retain their original capture time; use a new capture time only for a new
export. Reuse the same run ID for retries of identical input and year; corrected
inputs require a new ID. Same-ID different-content replays fail. A no-change
snapshot with a later capture time creates no new facts or impacts.

Each database supports one watch scope and chronological source chain. Use
separate databases for different scopes, sources, or branches. Complete runs
compare against the most recent complete run. Source/scope/time mismatches fail
closed. Quarantined rows persist in failed source runs but cannot participate
in comparisons. A failure during comparison or matching rolls back the whole
new run and its facts. Malformed envelopes and acquisition failures are visible
in attempt summaries even when no valid source-run envelope could be stored.
`status: failed` is not an assertion that active alerts are zero.

An exclusive `<database>.pipeline.lock` covers acquisition through checkpoint
and summary writing. Outbox/retention commands use the same lock. The legacy
`pipeline:eliquis` commands and external writers do not honor this lock, so run
them while the scheduler is stopped. Preview refuses a database with a WAL.
The lock records PID, host, and start time. After a crash, confirm that the owning
process is stopped, checkpoint/recover the database if necessary, then remove
only that database's lock file. Locks are never automatically stolen on age.

Transient acquisition errors (`EBUSY`, `EAGAIN`, `ETIMEDOUT`, `ECONNRESET`) get at
most 4 attempts, waiting 250/500/1000 ms. Permanent errors and validation failures
are not retried. Public CMS HTTP imports retain their existing bounded 429/5xx
retry policy. Nonzero exit means failure; the JSON summary identifies the failed
stage without echoing potentially sensitive exceptions.

### Artifacts and retention

`--artifacts PATH` defaults to `data/raw/daily`. `snapshots/` contains exclusive,
content-addressed raw JSON and first-capture metadata. `attempts/` contains one
exclusive timestamp/UUID JSON file per executed attempt, including failed and
preview runs. Overlap rejection happens before an attempt starts and exits with
an explicit lock error. Summary counts distinguish new facts/impacts from active
impacts; replay returns zero new counts and refreshes the active count from stored
unresolved impacts, so replaying an old adverse run cannot revive a resolved alert.

```powershell
npm run pipeline:ops -- retention --db data/eliquis-daily.duckdb --root data/raw/daily/snapshots --days 90
```

Retention defaults to keeping all evidence. This inventory marks age and
observation references; it never deletes files. Review older, unreferenced
artifacts and failed-attempt evidence before moving them to a backed-up archive.
Preserve referenced artifacts for the lifetime of their observations, along with
the database, metadata, and failed-run evidence needed for audit/replay. Hashes
alone cannot reconstruct deleted source content.

### Scheduler example (no scheduler is installed by these commands)

For Windows Task Scheduler, select a daily trigger, disable overlapping instances,
and set the working directory to the repository root. A PowerShell action can run:

```powershell
& npm.cmd run pipeline:daily -- --input data/raw/latest-cms.json --run cms-release-capture-id --year 2024 --commit
exit $LASTEXITCODE
```

The acquisition process must atomically replace `latest-cms.json` and change the
run ID when its contents change. A wrapper can derive the ID from the snapshot's
SHA-256; do not use a fixed ID for changing content. A static input/ID is a safe
idempotent replay. On POSIX the equivalent command can be invoked by cron with
an explicit `cd` and output capture. Alert on nonzero exit and review quarantine
counts. Back up only a closed/checkpointed DuckDB database.

## 07: optional normalized cross-source report

```powershell
npm run pipeline:ops -- cross-check --input path/to/aligned-sources.json
```

Input shape:

```json
{
  "cms": { "effectivePeriod": { "start": "2026-09-01", "end": "2026-10-01" }, "observations": [] },
  "humana": { "effectivePeriod": { "start": "2026-09-01", "end": "2026-10-01" }, "observations": [] },
  "mappings": [{
    "cms": { "contractId": "S5884", "planId": "135", "segmentId": "000", "sourcePlanId": "S5884-135-000" },
    "humana": { "contractId": "S5884", "planId": "135", "segmentId": "000", "sourcePlanId": "verified-humana-source-id" }
  }]
}
```

Supply actual normalized `CoverageObservation` objects and verified source plan
identities. Periods are explicit source assertions, with an exclusive end; a
release publication date or capture timestamp does not prove an effective period.
The real baseline has no such assertion, so it cannot prove live alignment.
Missing periods produce `timing_mismatch`, not a discrepancy. The adapter accepts
one snapshot per source, rejects ambiguous observations and nonunique mappings,
compares coverage and known restrictions, and normalizes QL to amount/day.
Coverage discrepancies are high severity; restriction discrepancies are medium.
Each discrepancy includes both observation IDs, run/release IDs, artifact hashes,
and provenance. Agreement, disagreement, unknown values, missing mapping, missing
observation, and timing mismatch remain distinct check outcomes.

The adapter returns a separate report; it never edits primary-source observations
or coverage-change facts. A verified live Humana acquisition/parser remains
unavailable from the earlier access spike. Tests use explicitly simulated Humana
observations and make no claim that a live discrepancy was demonstrated.

## 08: console preview and outbox

```powershell
npm run pipeline:ops -- outbox --db data/eliquis-daily.duckdb --year 2024
npm run pipeline:ops -- reply --reply STOP
```

Outbox IDs are stable for impact plus template version. Repeated enqueue/drain
does not re-preview successful entries. Pending/failed entries for resolved
changes are cancelled before processing. Preview attempts persist before console
output and are capped at three; a later drain retries failures. No adapter error
text is stored. Recipient logs are redacted; the outbox holds only a hashed
recipient reference, never a phone number or raw NPI. Content includes only the
aggregate change, annual claims, provenance, and interpretive limitations.

A process crash between console output and status persistence may duplicate a
console preview on recovery; this is not an exactly-once external-delivery claim.
There is no SMS provider, credential handling, live-send option, webhook, or
subscription mutation. Reply normalization reports stop/start/acknowledge/unknown
without applying API-owned workflow or consent state. A future authorized live
adapter requires its own delivery and webhook design.

## Verification

```powershell
npm run pipeline:e2e
npm test
npx tsc --noEmit
npm run lint
```

The operations suite covers the real-baseline proof, dry-run isolation, no-change
and duplicate runs, quarantine, chronology, rollback after matching failure,
overlap locks, bounded retries, retained artifacts, source alignment, SMS
formatting/redaction, retry budgets, cancellation, and normalized replies.

Verified on 2026-09-26: **154 tests passed, 1 opt-in live test skipped** using
`RUINED_DB=data/verified-scenario.duckdb`; TypeScript and lint passed. The offline
CLI produced matching independent runs and duplicate-free replay. Daily preview,
local commit, and retention inventory commands passed against the isolated
`data/eliquis-operations-verified.duckdb` verification database. Generated output
is under ignored `data/raw/`; no scheduler or external delivery was activated.
