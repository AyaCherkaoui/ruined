import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { openDb } from "../lib/db";
import { initializeAggregate } from "../lib/pipeline/aggregate-store";
import { crossCheck } from "../lib/pipeline/cross-source";
import { acquirePipelineLock, retentionInventory } from "../lib/pipeline/daily-runner";
import { drainSmsPreviews, enqueueSmsPreviews, normalizeReply } from "../lib/pipeline/sms-outbox";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(["db", "input", "year", "root", "days", "reply"].map((key) => [key, { type: "string" as const }])) });
  const command = positionals[0];
  const required = (key: string) => { if (!values[key]) throw new Error(`Missing --${key}`); return values[key]; };
  if (command === "cross-check") {
    const input = JSON.parse(await fs.readFile(required("input"), "utf8"));
    console.log(JSON.stringify(crossCheck(input.cms, input.humana, input.mappings), null, 2)); return;
  }
  if (command === "reply") { console.log(JSON.stringify({ reply: normalizeReply(required("reply")), applied: false })); return; }
  if (!["outbox", "retention"].includes(command)) throw new Error("Usage: aggregate-operations <cross-check|outbox|retention|reply>");
  const selectedPath = values.db ?? "data/eliquis-daily.duckdb";
  const release = await acquirePipelineLock(selectedPath);
  try {
    const db = await openDb({ path: selectedPath });
    try {
      await initializeAggregate(db);
      if (command === "retention") console.log(JSON.stringify(await retentionInventory(db, required("root"), Number(values.days ?? 90)), null, 2));
      else {
        const year = Number(required("year"));
        if (!Number.isInteger(year) || year < 2013) throw new Error("Invalid source year");
        await enqueueSmsPreviews(db, year);
        const entries = await drainSmsPreviews(db);
        console.log(JSON.stringify({ mode: "dry-run", externalMessagesSent: 0, entries: entries.map((e) => ({ id: e.id, status: e.status, attempts: e.attempts })) }, null, 2));
      }
    } finally { await db.close(); }
  } finally { await release(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Operation failed"); process.exitCode = 1; });
