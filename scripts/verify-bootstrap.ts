import fs from "node:fs";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { saveDrug, type DrugRecord } from "../lib/drugs";
import { ingestRelease, type ManifestEntry } from "../lib/pipeline/ingestRelease";
import { detectChanges } from "../lib/pipeline/detectChanges";
import { matchPrescriptions } from "../lib/pipeline/matchPrescriptions";
import { seedScenario, CHOSEN_RXCUI, LOST_COVERAGE_PLAN, KEPT_COVERAGE_PLAN } from "./seed-scenario";

async function main() {
  const db = await openDb();
  try {
    for (const line of fs.readFileSync("data/drug_cache.jsonl", "utf8").split(/\r?\n/).filter(Boolean)) await saveDrug(db, JSON.parse(line) as DrugRecord);
    const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(process.argv[2] ?? "data/raw/bootstrap-releases.json", "utf8"));
    for (const version of ["v1", "v2-cms"]) {
      const entry = manifest.find((m) => m.dataVersion === version);
      assert(entry?.fileHash, `Missing hashed manifest for ${version}`);
      for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
        const [row] = await db.query<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE data_version=$1`, [version]);
        assert(row.n > 0, `${version}: empty ${table}`);
      }
      for (const plan of [LOST_COVERAGE_PLAN, KEPT_COVERAGE_PLAN]) {
        const rows = await db.query("SELECT 1 FROM plans WHERE data_version=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4", [version, plan.contractId, plan.planId, plan.segmentId]);
        assert(rows.length, `Missing required plan in ${version}`);
      }
      const drugs = await db.query("SELECT 1 FROM formulary WHERE data_version=$1 AND rxcui=$2 LIMIT 1", [version, CHOSEN_RXCUI]);
      assert(drugs.length, `Missing NovoLog in ${version}`);
      await ingestRelease(entry, db);
    }
    await seedScenario(db);
    const run = async () => {
      const changes = await detectChanges("v1", "v2-cms", [CHOSEN_RXCUI], db);
      const alerts = await matchPrescriptions(changes.map((c) => c.id), db);
      return { changes: changes.map((c) => c.id).sort(), alerts: alerts.map((a) => a.id).sort(), counts: await db.query("SELECT (SELECT count(*) FROM coverage_changes) changes, (SELECT count(*) FROM patient_alerts) alerts") };
    };
    const first = await run();
    assert(first.alerts.length > 0, "Expected baseline coverage-loss alerts");
    assert.deepEqual(await run(), first);
    console.log(JSON.stringify({ bootstrap: "verified", ...first }, null, 2));
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
