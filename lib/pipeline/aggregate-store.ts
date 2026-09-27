import crypto from "node:crypto";
import fs from "node:fs";
import type { Db } from "../db";
import type { CoverageObservation, CoveragePlanKey, CoverageSource } from "./aggregate-contract";

export const WATCHED_RXCUIS = ["1364447", "1364441"] as const;
export const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const stableId = (...parts: unknown[]) => hash(JSON.stringify(parts));
export const planKey = (plan: CoveragePlanKey) => JSON.stringify([plan.contractId, plan.planId, plan.segmentId]);
export const observationKey = (o: CoverageObservation) => JSON.stringify([planKey(o.plan), o.rxcui, o.ndc]);
export interface SourceRun {
  id: string;
  source: CoverageSource;
  capturedAt: string;
  expectedKeys: string[];
  status: "completed" | "failed";
  quarantine: { locator: string; reason: string }[];
}

export async function initializeAggregate(db: Db) {
  const sql = fs.readFileSync("data/aggregate-schema.sql", "utf8");
  for (const stmt of sql.split("\n").filter((s) => !s.trim().startsWith("--")).join("\n").split(";").filter((s) => s.trim())) await db.run(stmt);
}

export function validateObservation(o: CoverageObservation): void {
  if (!o || !o.plan || !o.quantityLimit) throw new Error("Missing observation fields");
  if (![o.plan.contractId, o.plan.planId, o.plan.segmentId, o.plan.sourcePlanId, o.sourceRunId, o.sourceReleaseId].every((s) => typeof s === "string" && s.length > 0)) throw new Error("Missing identity");
  if (!WATCHED_RXCUIS.some((r) => r === o.rxcui)) throw new Error("Unwatched RXCUI");
  if (!["cms_monthly", "humana_fhir"].includes(o.source) || !["live", "replay", "simulated"].includes(o.provenance)) throw new Error("Invalid source/provenance");
  if (typeof o.covered !== "boolean" || ![o.priorAuthorization, o.stepTherapy, o.quantityLimit.applies].every((v) => v === null || typeof v === "boolean")) throw new Error("Invalid coverage/restriction");
  if (o.tier !== null && (!Number.isInteger(o.tier) || o.tier < 1)) throw new Error("Invalid tier");
  if (o.ndc !== null && !/^\d{11}$/.test(o.ndc)) throw new Error("Invalid NDC");
  for (const v of [o.quantityLimit.amount, o.quantityLimit.days]) if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error("Invalid quantity limit");
  if (!Number.isFinite(Date.parse(o.capturedAt)) || (o.effectiveAt !== null && !Number.isFinite(Date.parse(o.effectiveAt)))) throw new Error("Invalid timestamp");
  if (!/^[a-f0-9]{64}$/.test(o.rawArtifactHash)) throw new Error("Invalid artifact hash");
}

/** Immutable runs: a replay is a no-op; changing content under the same id is an error. */
export async function persistRun(db: Db, run: SourceRun, observations: CoverageObservation[]): Promise<void> {
  if (!run.id || !Number.isFinite(Date.parse(run.capturedAt))) throw new Error("Invalid run identity/time");
  const sorted = [...observations].sort((a, b) => observationKey(a).localeCompare(observationKey(b)));
  const keys = sorted.map(observationKey);
  for (const o of sorted) {
    validateObservation(o);
    if (o.sourceRunId !== run.id || o.source !== run.source || o.capturedAt !== run.capturedAt) throw new Error("Observation/run mismatch");
    o.id = stableId(o.source, run.id, o.plan.contractId, o.plan.planId, o.plan.segmentId, o.rxcui, o.ndc);
  }
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate observation key");
  if (run.status === "completed" && (run.quarantine.length || keys.length === 0 || JSON.stringify([...run.expectedKeys].sort()) !== JSON.stringify([...keys].sort()))) throw new Error("Incomplete run cannot be completed");
  const fingerprint = stableId(run, sorted);
  const existing = await db.query<{ fingerprint: string }>("SELECT fingerprint FROM source_runs WHERE id=$1", [run.id]);
  if (existing.length) {
    if (existing[0].fingerprint !== fingerprint) throw new Error("Run id already has different content");
    return;
  }
  await db.run("BEGIN TRANSACTION");
  try {
    await db.run("INSERT INTO source_runs VALUES ($1,$2,$3,$4,$5,$6)", [run.id, run.source, run.capturedAt, run.status, fingerprint, JSON.stringify(run)]);
    for (const o of sorted) await db.run("INSERT INTO coverage_observations VALUES ($1,$2,$3,$4)", [o.id, run.id, observationKey(o), JSON.stringify(o)]);
    await db.run("COMMIT");
  } catch (error) { await db.run("ROLLBACK"); throw error; }
}

export async function readRun(db: Db, id: string) {
  const [row] = await db.query<{ payload: string }>("SELECT payload FROM source_runs WHERE id=$1", [id]);
  if (!row) throw new Error(`Unknown run: ${id}`);
  const observations = await db.query<{ payload: string }>("SELECT payload FROM coverage_observations WHERE run_id=$1 ORDER BY observation_key", [id]);
  return { run: JSON.parse(row.payload) as SourceRun, observations: observations.map((r) => JSON.parse(r.payload) as CoverageObservation) };
}
