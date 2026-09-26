#!/usr/bin/env -S npx tsx
/**
 * Runs the full pipeline: ingestRelease (data/releases.json) -> detectChanges (v1 -> v2-cms) ->
 * matchPrescriptions, and prints a report. All three steps are idempotent -- rerunning never
 * duplicates a data_versions / coverage_changes / patient_alerts row.
 *
 *   npx tsx scripts/run-pipeline.ts                 # full scan, every rxcui
 *   npx tsx scripts/run-pipeline.ts 1653204 351926   # scoped to specific rxcuis
 */
import fs from "node:fs";
import path from "node:path";
import { detectChanges } from "../lib/pipeline/detectChanges";
import { ingestRelease, type ManifestEntry } from "../lib/pipeline/ingestRelease";
import { matchPrescriptions } from "../lib/pipeline/matchPrescriptions";
import { openDb } from "../lib/db";

const FROM_VERSION = "v1";
const TO_VERSION = "v2-cms";

async function main() {
  const db = await openDb();
  const rxcuis = process.argv.slice(2);

  const manifestPath = path.join(process.cwd(), "data/releases.json");
  const manifest: ManifestEntry[] = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : [];
  console.log(`== ingestRelease: ${manifest.length} entries in data/releases.json ==`);
  for (const entry of manifest) {
    const row = await ingestRelease(entry, db);
    console.log(`  ${row.id.padEnd(10)} ${row.source.slice(0, 60)} (hash ${row.fileHash ? row.fileHash.slice(0, 12) + "..." : "n/a"}, loaded ${row.loadedAt})`);
  }

  console.log(`\n== detectChanges: ${FROM_VERSION} -> ${TO_VERSION}${rxcuis.length ? ` (rxcuis: ${rxcuis.join(", ")})` : " (full scan)"} ==`);
  const changes = await detectChanges(FROM_VERSION, TO_VERSION, rxcuis.length ? rxcuis : undefined, db);
  for (const c of changes) {
    console.log(`  ${c.changeType.padEnd(18)} formulary=${c.formularyId} rxcui=${c.rxcui} tier ${c.oldTier ?? "-"}->${c.newTier ?? "-"}`);
  }
  console.log(`  ${changes.length} adverse changes.`);

  console.log(`\n== matchPrescriptions ==`);
  const alerts = await matchPrescriptions(changes.map((c) => c.id), db);
  for (const a of alerts) {
    console.log(`  patient=${a.patientId} prescription=${a.prescriptionId} $${a.oldMonthlyCost ?? "?"} -> $${a.newMonthlyCost ?? "?"} alt=${a.bestAlternativeRxcui ?? "none"}`);
  }
  console.log(`  ${alerts.length} patient alerts.`);

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
