/**
 * Fill the `drugs` cache for every RXCUI on the Georgia formularies (RxNav + RxClass).
 *
 *   npm run warm-drugs                 # fetch missing, then import into the DB
 *   npm run warm-drugs -- --import-only  # just (re)load data/drug_cache.jsonl into the DB
 *
 * Progress is appended to data/drug_cache.jsonl as it goes, so an interrupted run resumes
 * where it left off. The file is small and committed, so the DB can be rebuilt without the network.
 * Uses ~3 API calls per drug (~14k total), throttled to ~15 requests/second.
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db";
import { fetchDrugRecord, saveDrug, type DrugRecord } from "../lib/drugs";
import { RxNavClient } from "../lib/rxnav";

const CACHE_FILE = path.join(process.cwd(), "data", "drug_cache.jsonl");
const CONCURRENCY = 4;

type CacheLine = { rxcui: string; missing: true } | DrugRecord;

function readCache(): Map<string, CacheLine> {
  const out = new Map<string, CacheLine>();
  if (!fs.existsSync(CACHE_FILE)) return out;
  for (const line of fs.readFileSync(CACHE_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as CacheLine;
    out.set(rec.rxcui, rec);
  }
  return out;
}

async function main() {
  const importOnly = process.argv.includes("--import-only");
  const cache = readCache();

  if (!importOnly) {
    const ro = await openDb({ readOnly: true });
    const rows = await ro.query<{ rxcui: string }>("SELECT DISTINCT rxcui FROM formulary ORDER BY rxcui");
    await ro.close();
    const todo = rows.map((r) => r.rxcui).filter((id) => !cache.has(id));
    console.log(`${rows.length} formulary rxcuis, ${cache.size} cached, ${todo.length} to fetch`);

    const rx = new RxNavClient({ minIntervalMs: 65 });
    let done = 0;
    let failed = 0;
    const started = Date.now();
    const worker = async () => {
      for (;;) {
        const rxcui = todo.pop();
        if (!rxcui) return;
        try {
          const rec = await fetchDrugRecord(rxcui, rx);
          const line: CacheLine = rec ?? { rxcui, missing: true };
          fs.appendFileSync(CACHE_FILE, JSON.stringify(line) + "\n");
          cache.set(rxcui, line);
        } catch (err) {
          failed++;
          console.error(`failed ${rxcui}: ${(err as Error).message}`);
        }
        if (++done % 100 === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`${done} fetched (${failed} failed), ${(todo.length / rate / 60).toFixed(1)} min left`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`fetch done: ${done} fetched, ${failed} failed (rerun to retry failures)`);
  }

  const db = await openDb();
  let imported = 0;
  for (const rec of cache.values()) {
    if ("missing" in rec) continue;
    await saveDrug(db, rec);
    imported++;
  }
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM drugs");
  const [{ withClass }] = await db.query<{ withClass: number }>("SELECT count(*) AS \"withClass\" FROM drugs WHERE class_id IS NOT NULL");
  console.log(`imported ${imported}; drugs table has ${n} rows, ${withClass} with an ATC class`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
