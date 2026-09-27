import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDb, type Db } from "../db";
import type { DoctorImpact } from "./aggregate-contract";
import { hash, initializeAggregate, readRun, type SourceRun } from "./aggregate-store";
import { archiveRaw, ingestCmsSnapshot } from "./cms-snapshots";
import { compareSnapshots, readChanges } from "./compare-snapshots";
import { matchPrescriberImpacts } from "./prescriber-impact";

export interface DailySummary {
  runId: string; mode: "dry-run" | "commit"; status: "completed" | "failed";
  inputHash: string | null; previousRunId: string | null; observations: number;
  newFacts: number; newImpacts: number; activeImpacts: number;
  quarantine: SourceRun["quarantine"]; replayed: boolean; error: string | null;
}
export interface DailyOptions {
  dbPath: string; runId: string; sourceYear: number; commit?: boolean;
  artifactRoot: string; acquire: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

/** No automatic stale-lock stealing: an operator verifies the owning process first. */
export async function acquirePipelineLock(databasePath: string) {
  const lockPath = path.resolve(databasePath) + ".pipeline.lock";
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await fs.open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Pipeline overlap lock exists; verify the owning process before removing it");
    throw error;
  });
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await fs.unlink(lockPath); throw error; }
  return async () => { await handle.close(); await fs.unlink(lockPath); };
}

export async function acquireWithRetry(acquire: () => Promise<string>, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await acquire(); }
    catch (error) {
      if (attempt === 3 || !["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

/** One outer transaction composes the existing transactional pipeline helpers. */
function transactionView(db: Db): Db {
  return { query: db.query.bind(db), close: async () => { throw new Error("Cannot close transaction view"); },
    run: async (sql, params) => { if (!/^(BEGIN TRANSACTION|COMMIT|ROLLBACK)$/.test(sql.trim())) await db.run(sql, params); } };
}

export async function runDaily(options: DailyOptions): Promise<DailySummary> {
  if (!options.runId || !Number.isInteger(options.sourceYear) || options.sourceYear < 2013) throw new Error("Run id and valid source year are required");
  const release = await acquirePipelineLock(options.dbPath);
  let db: Db | undefined;
  let temporary: string | undefined;
  const summary: DailySummary = { runId: options.runId, mode: options.commit ? "commit" : "dry-run", status: "failed", inputHash: null, previousRunId: null, observations: 0, newFacts: 0, newImpacts: 0, activeImpacts: 0, quarantine: [], replayed: false, error: null };
  let stage = "acquire";
  try {
    const body = await acquireWithRetry(options.acquire, options.sleep);
    summary.inputHash = await archiveRaw(path.join(options.artifactRoot, "snapshots"), body, { source: "cms_monthly", page: 1, status: 200, capturedAt: new Date().toISOString() });
    stage = "database";
    let selectedPath = options.dbPath;
    if (!options.commit) {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), "eliquis-daily-"));
      selectedPath = path.join(temporary, "preview.duckdb");
      // A WAL indicates an uncheckpointed/active writer; do not copy a partial DB.
      try { await fs.access(options.dbPath + ".wal"); throw new Error("Database WAL exists; stop writer before preview"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await fs.copyFile(options.dbPath, selectedPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    db = await openDb({ path: selectedPath });
    await initializeAggregate(db);
    const [replay] = await db.query<{ input_hash: string; payload: string }>("SELECT input_hash, payload FROM daily_executions WHERE run_id=$1", [options.runId]);
    // Year participates in replay identity because it controls impact matching.
    const fingerprint = hash(JSON.stringify([body, options.sourceYear]));
    if (replay) {
      if (replay.input_hash !== fingerprint) throw new Error("Daily run id already has different input/year");
      Object.assign(summary, JSON.parse(replay.payload), { mode: summary.mode, replayed: true, newFacts: 0, newImpacts: 0 });
      const activeChanges = new Set((await readChanges(db)).filter((c) => c.direction === "worsened" && !c.resolvedByChangeId).map((c) => c.id));
      const storedImpacts = await db.query<{ payload: string }>("SELECT payload FROM doctor_impacts");
      summary.activeImpacts = storedImpacts.map((r) => JSON.parse(r.payload) as DoctorImpact).filter((i) => i.sourceYear === options.sourceYear && activeChanges.has(i.changeId)).length;
    } else {
      await db.run("BEGIN TRANSACTION");
      try {
        const tx = transactionView(db);
        stage = "validate";
        const result = await ingestCmsSnapshot(tx, body, options.runId, path.join(options.artifactRoot, "snapshots"));
        summary.observations = result.observations.length;
        summary.quarantine = result.run.quarantine;
        if (result.run.status === "completed") {
          stage = "compare";
          const previous = await tx.query<{ id: string }>("SELECT id FROM source_runs WHERE status='completed' AND id<>$1 ORDER BY captured_at DESC, id DESC LIMIT 1", [options.runId]);
          if (previous.length) {
            summary.previousRunId = previous[0].id;
            // compareSnapshots enforces scope, source, chronology, and chain continuity.
            const [before] = await tx.query<{ n: number }>("SELECT count(*) n FROM coverage_change_facts");
            await compareSnapshots(tx, previous[0].id, options.runId);
            const [after] = await tx.query<{ n: number }>("SELECT count(*) n FROM coverage_change_facts");
            summary.newFacts = after.n - before.n;
          }
          stage = "match";
          const [before] = await tx.query<{ n: number }>("SELECT count(*) n FROM doctor_impacts");
          summary.activeImpacts = (await matchPrescriberImpacts(tx, options.sourceYear)).length;
          const [after] = await tx.query<{ n: number }>("SELECT count(*) n FROM doctor_impacts");
          summary.newImpacts = after.n - before.n;
          summary.status = "completed";
        } else summary.error = "Snapshot failed completeness/validation; comparison skipped";
        await tx.run("INSERT INTO daily_executions VALUES ($1,$2,$3)", [options.runId, fingerprint, JSON.stringify(summary)]);
        await db.run("COMMIT");
      } catch (error) { await db.run("ROLLBACK"); throw error; }
    }
  } catch {
    summary.status = "failed";
    summary.newFacts = 0; summary.newImpacts = 0; summary.activeImpacts = 0;
    summary.error = `Daily ${stage} failed; no changes committed. Check source input, run identity, chronology, and database access.`;
  } finally {
    try {
      if (db) await db.close();
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      const directory = path.join(options.artifactRoot, "attempts");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ recordedAt: new Date().toISOString(), ...summary }, null, 2) + "\n", { flag: "wx" });
    } finally { await release(); }
  }
  return summary;
}

/** Retention is an inventory only: evidence referenced by observations is never deleted. */
export async function retentionInventory(db: Db, root: string, days = 90, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1) throw new Error("Retention days must be a positive integer");
  const referenced = new Set<string>();
  for (const { id } of await db.query<{ id: string }>("SELECT id FROM source_runs")) {
    for (const o of (await readRun(db, id)).observations) referenced.add(o.rawArtifactHash);
  }
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}(\.meta)?\.json$/.test(entry.name)) continue;
    const stat = await fs.stat(path.join(root, entry.name));
    files.push({ file: entry.name, referenced: referenced.has(entry.name.slice(0, 64)), olderThanPolicy: now - stat.mtimeMs > days * 86400000 });
  }
  return { policyDays: days, action: "inventory-only", files: files.sort((a, b) => a.file.localeCompare(b.file)) };
}
