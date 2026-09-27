import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Db } from "../db";
import type { EliquisAggregatePayloadV1 } from "./aggregate-contract";
import { hash, readRun } from "./aggregate-store";
import { ingestCmsSnapshot, type CmsSnapshot } from "./cms-snapshots";
import { compareSnapshots, readChanges } from "./compare-snapshots";
import { declarePlanAcceptance, loadPrescriberVolumes, matchPrescriberImpacts } from "./prescriber-impact";
import { consolePreviewAdapter, drainSmsPreviews, enqueueSmsPreviews } from "./sms-outbox";

export async function aggregatePayload(db: Db, year: number): Promise<EliquisAggregatePayloadV1> {
  const rows = await db.query<{ id: string }>("SELECT id FROM source_runs WHERE status='completed' ORDER BY captured_at, id");
  const observations = [];
  for (const { id } of rows) observations.push(...(await readRun(db, id)).observations);
  return { contractVersion: "eliquis-aggregate-v1", observations, changes: await readChanges(db), doctorImpacts: await matchPrescriberImpacts(db, year) };
}

/** Fixed clock and IDs make the entire offline proof reproducible. */
export async function runDemo(db: Db, rawRoot: string) {
  const body = await fs.readFile("data/fixtures/eliquis/real-baseline.json", "utf8");
  const manifest = JSON.parse(await fs.readFile("data/fixtures/eliquis/real-baseline.manifest.json", "utf8"));
  assert.equal(hash(body.replaceAll("\r\n", "\n")), manifest.snapshotHash, "Real baseline fixture hash mismatch");
  const baseline = JSON.parse(body) as CmsSnapshot;
  assert.equal(baseline.releaseHash, manifest.releaseHash);
  assert.equal(baseline.provenance, "replay");
  const adverse = structuredClone(baseline);
  adverse.provenance = "simulated";
  adverse.releaseId = "demo-simulated-adverse";
  adverse.capturedAt = "2026-09-28T00:00:00.000Z";
  assert.ok(adverse.entries[0].rows.every((r) => r.prior_authorization === false));
  for (const row of adverse.entries[0].rows) row.prior_authorization = true;
  const restored = structuredClone(baseline);
  restored.provenance = "simulated";
  restored.releaseId = "demo-simulated-restored";
  restored.capturedAt = "2026-09-29T00:00:00.000Z";
  for (const [id, snapshot] of [["demo-baseline", baseline], ["demo-adverse", adverse]] as const) {
    assert.equal((await ingestCmsSnapshot(db, JSON.stringify(snapshot), id, rawRoot)).run.status, "completed");
  }
  await loadPrescriberVolumes(db, [{ Prscrbr_NPI: "0000000000", Prscrbr_State_Abrvtn: "GA", Brnd_Name: "Eliquis", Gnrc_Name: "Apixaban", Tot_Clms: "184" }], 2024, "demo-synthetic-aggregate", "simulated");
  await declarePlanAcceptance(db, "0000000000", baseline.plans[0]);
  await compareSnapshots(db, "demo-baseline", "demo-adverse");
  const adversePayload = await aggregatePayload(db, 2024);
  assert.equal(adversePayload.doctorImpacts.length, 1);
  assert.equal(adversePayload.changes[0].changeType, "prior_authorization_added");
  const previews: string[] = [];
  const adapter = consolePreviewAdapter((line) => previews.push(line));
  await enqueueSmsPreviews(db, 2024);
  await drainSmsPreviews(db, adapter);
  await enqueueSmsPreviews(db, 2024);
  await drainSmsPreviews(db, adapter);
  assert.equal(previews.length, 1);
  assert.equal((await ingestCmsSnapshot(db, JSON.stringify(restored), "demo-restored", rawRoot)).run.status, "completed");
  await compareSnapshots(db, "demo-adverse", "demo-restored");
  const finalPayload = await aggregatePayload(db, 2024);
  assert.equal(finalPayload.doctorImpacts.length, 0);
  const added = finalPayload.changes.find((c) => c.changeType === "prior_authorization_added")!;
  const removed = finalPayload.changes.find((c) => c.changeType === "prior_authorization_removed")!;
  assert.equal(added.resolvedByChangeId, removed.id);
  assert.equal(removed.resolvesChangeId, added.id);
  // Replay into the SAME database proves row counts and final payload are stable.
  for (const [id, snapshot] of [["demo-baseline", baseline], ["demo-adverse", adverse], ["demo-restored", restored]] as const) await ingestCmsSnapshot(db, JSON.stringify(snapshot), id, rawRoot);
  await compareSnapshots(db, "demo-baseline", "demo-adverse");
  await compareSnapshots(db, "demo-adverse", "demo-restored");
  assert.deepEqual(await aggregatePayload(db, 2024), finalPayload);
  const counts: Record<string, number> = {};
  for (const table of ["source_runs", "coverage_observations", "coverage_change_facts", "doctor_impacts"]) {
    const [row] = await db.query<{ n: number }>(`SELECT count(*) n FROM ${table}`);
    counts[table] = row.n;
  }
  assert.deepEqual(counts, { source_runs: 3, coverage_observations: 12, coverage_change_facts: 2, doctor_impacts: 1 });
  return { baseline: manifest, simulation: "PA added then removed; synthetic signup and annual claims volume", adversePayload, finalPayload, delivery: { externalMessagesSent: 0, previews: previews.map((line) => JSON.parse(line)) }, verification: { duplicateFree: true, counts } };
}
