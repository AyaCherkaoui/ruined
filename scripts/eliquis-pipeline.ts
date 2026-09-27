import fs from "node:fs";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { openDb } from "../lib/db";
import { initializeAggregate, readRun } from "../lib/pipeline/aggregate-store";
import { exportCmsSnapshot, ingestCmsSnapshot } from "../lib/pipeline/cms-snapshots";
import { compareSnapshots, readChanges } from "../lib/pipeline/compare-snapshots";
import { declarePlanAcceptance, fetchPrescriberRows, loadPrescriberVolumes, matchPrescriberImpacts, type CmsPrescriberRow } from "../lib/pipeline/prescriber-impact";
import type { CoveragePlanKey } from "../lib/pipeline/aggregate-contract";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["db", "input", "run", "from", "to", "year", "dataset", "plans", "source-db", "release", "captured-at", "output", "source-id", "provenance"].map((k) => [k, { type: "string" as const }])) });
  const required = (key: string) => { const value = values[key]; if (!value) throw new Error(`Missing --${key}`); return value; };
  const command = positionals[0];
  if (!command || !["ingest", "export-cms", "compare", "load-prescribers", "accept-plans", "impact", "payload"].includes(command)) throw new Error("Usage: eliquis-pipeline <export-cms|ingest|compare|load-prescribers|accept-plans|impact|payload> (see docs/pipeline-milestones.md)");
  if (command === "export-cms") {
    const source = await openDb({ path: required("source-db"), readOnly: true });
    try {
      const plans: CoveragePlanKey[] = JSON.parse(fs.readFileSync(required("plans"), "utf8"));
      const snapshot = await exportCmsSnapshot(source, required("release"), plans, required("captured-at"));
      fs.writeFileSync(required("output"), JSON.stringify(snapshot, null, 2));
    } finally { await source.close(); }
    return;
  }
  const db = await openDb({ path: values.db ?? "data/eliquis.duckdb" });
  try {
    await initializeAggregate(db);
    let result: unknown;
    if (command === "ingest") {
      result = await ingestCmsSnapshot(db, fs.readFileSync(required("input"), "utf8"), required("run"));
      if ((result as Awaited<ReturnType<typeof ingestCmsSnapshot>>).run.status !== "completed") process.exitCode = 1;
    } else if (command === "compare") result = await compareSnapshots(db, required("from"), required("to"));
    else if (command === "load-prescribers") {
      const year = Number(required("year"));
      async function* localRows() {
        const reader = readline.createInterface({ input: fs.createReadStream(required("input")), crlfDelay: Infinity });
        for await (const line of reader) if (line.trim()) yield JSON.parse(line) as CmsPrescriberRow;
      }
      const provenance = values.dataset ? "live" : required("provenance");
      if (!["live", "replay", "simulated"].includes(provenance)) throw new Error("Invalid provenance");
      result = { loaded: await loadPrescriberVolumes(db, values.dataset ? fetchPrescriberRows(values.dataset) : localRows(), year, values.dataset ?? required("source-id"), provenance as "live" | "replay" | "simulated") };
    } else if (command === "accept-plans") {
      const rows: { npi: string; plan: CoveragePlanKey }[] = JSON.parse(fs.readFileSync(required("input"), "utf8"));
      for (const row of rows) await declarePlanAcceptance(db, row.npi, row.plan);
      result = { declared: rows.length, source: "demo_signup" };
    } else if (command === "impact") result = await matchPrescriberImpacts(db, Number(required("year")));
    else {
      const ids = await db.query<{ id: string }>("SELECT id FROM source_runs WHERE status='completed' ORDER BY captured_at, id");
      const observations = [];
      for (const { id } of ids) observations.push(...(await readRun(db, id)).observations);
      result = { contractVersion: "eliquis-aggregate-v1", observations, changes: await readChanges(db), doctorImpacts: await matchPrescriberImpacts(db, Number(required("year"))) };
    }
    const json = JSON.stringify(result, null, 2);
    if (values.output) fs.writeFileSync(values.output, json + "\n"); else console.log(json);
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
