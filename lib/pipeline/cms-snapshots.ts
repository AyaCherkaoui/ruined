import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db";
import type { CoverageObservation, CoveragePlanKey, CoverageProvenance } from "./aggregate-contract";
import { hash, observationKey, persistRun, planKey, validateObservation, WATCHED_RXCUIS, type SourceRun } from "./aggregate-store";

export interface CmsDrugRow {
  ndc: string; tier: number | null; prior_authorization: boolean | null; step_therapy: boolean | null;
  quantity_limit: boolean | null; quantity_limit_amount: number | null; quantity_limit_days: number | null;
}
export interface CmsSnapshot {
  format: "cms-eliquis-snapshot-v1";
  releaseId: string;
  releaseHash: string;
  capturedAt: string;
  effectiveAt: string | null;
  provenance: CoverageProvenance;
  plans: CoveragePlanKey[];
  entries: { plan: CoveragePlanKey; rxcui: string; rows: CmsDrugRow[] }[];
}

/** Export only two verified Humana plans from a complete, locally loaded CMS release. */
export async function exportCmsSnapshot(db: Db, releaseId: string, plans: CoveragePlanKey[], capturedAt: string): Promise<CmsSnapshot> {
  const [release] = await db.query<{ file_hash: string | null; release_date: unknown; source: string }>("SELECT file_hash, release_date, source FROM data_versions WHERE id=$1", [releaseId]);
  if (!release?.file_hash) throw new Error("Release requires a hashed bootstrap manifest");
  if (!/monthly|\/\d{4}_\d{8}\.zip/i.test(release.source)) throw new Error("CMS monthly adapter requires a monthly release");
  const entries: CmsSnapshot["entries"] = [];
  for (const plan of plans) {
    const matches = await db.query<{ formulary_id: string; contract_name: string; plan_name: string }>("SELECT DISTINCT formulary_id, contract_name, plan_name FROM plans WHERE data_version=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4", [releaseId, plan.contractId, plan.planId, plan.segmentId]);
    if (matches.length !== 1 || !/humana/i.test(`${matches[0].contract_name} ${matches[0].plan_name}`)) throw new Error("Plan must resolve uniquely to Humana");
    const [count] = await db.query<{ n: number }>("SELECT count(*) n FROM formulary WHERE data_version=$1 AND formulary_id=$2", [releaseId, matches[0].formulary_id]);
    if (!count.n) throw new Error("Empty formulary cannot prove noncoverage");
    for (const rxcui of WATCHED_RXCUIS) {
      const rows = await db.query<CmsDrugRow>("SELECT DISTINCT ndc, tier, prior_authorization, step_therapy, quantity_limit, quantity_limit_amount, quantity_limit_days FROM formulary WHERE data_version=$1 AND formulary_id=$2 AND rxcui=$3 ORDER BY ndc", [releaseId, matches[0].formulary_id, rxcui]);
      entries.push({ plan, rxcui, rows });
    }
  }
  return { format: "cms-eliquis-snapshot-v1", releaseId, releaseHash: release.file_hash, capturedAt,
    // A release date is not proof of a coverage effective date.
    effectiveAt: null, provenance: "replay", plans, entries };
}

export async function archiveRaw(root: string, body: string, metadata: { source: string; page: number; status: number; capturedAt: string }) {
  const digest = hash(body);
  await fs.mkdir(root, { recursive: true });
  // Content-addressed exclusive writes preserve the first capture on replay.
  for (const [suffix, content] of [[".json", body], [".meta.json", JSON.stringify({ ...metadata, sha256: digest }, null, 2)]]) {
    try { await fs.writeFile(path.join(root, digest + suffix), content, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return digest;
}

export async function ingestCmsSnapshot(db: Db, body: string, runId: string, rawRoot = "data/raw/cms-snapshots") {
  const input = JSON.parse(body) as CmsSnapshot;
  if (input.format !== "cms-eliquis-snapshot-v1" || !Array.isArray(input.plans) || input.plans.length !== 2 || new Set(input.plans.map(planKey)).size !== 2 || !Array.isArray(input.entries) || !/^[a-f0-9]{64}$/.test(input.releaseHash)) throw new Error("Invalid snapshot envelope");
  const digest = await archiveRaw(rawRoot, body, { source: "cms_monthly", page: 1, status: 200, capturedAt: input.capturedAt });
  const observations: CoverageObservation[] = [];
  const quarantine: SourceRun["quarantine"] = [];
  const expectedKeys = input.plans.flatMap((plan) => WATCHED_RXCUIS.map((rxcui) => observationKey({ plan, rxcui, ndc: null } as CoverageObservation)));
  const seen = new Map<string, string>();
  input.entries.forEach((entry, index) => {
    try {
      const key = observationKey({ plan: entry.plan, rxcui: entry.rxcui, ndc: null } as CoverageObservation);
      if (!expectedKeys.includes(key) || !input.plans.some((p) => planKey(p) === planKey(entry.plan) && p.sourcePlanId === entry.plan.sourcePlanId)) throw new Error("Out-of-scope identity");
      if (!Array.isArray(entry.rows)) throw new Error("Missing formulary rows");
      // Preserve every NDC in the raw artifact; collapse only identical restrictions.
      // Conflicting NDC-level coverage cannot safely be represented as one plan/RXCUI fact.
      const values = entry.rows.map((r) => {
        if (!/^\d{11}$/.test(r.ndc)) throw new Error("Invalid NDC");
        return JSON.stringify([r.tier, r.prior_authorization, r.step_therapy, r.quantity_limit, r.quantity_limit ? r.quantity_limit_amount : null, r.quantity_limit ? r.quantity_limit_days : null]);
      });
      if (new Set(values).size > 1) throw new Error("Conflicting NDC restrictions");
      const r = entry.rows[0];
      const o: CoverageObservation = { id: "", source: "cms_monthly", sourceReleaseId: input.releaseId, sourceRunId: runId, plan: entry.plan, rxcui: entry.rxcui, ndc: null,
        covered: !!r, tier: r?.tier ?? null, priorAuthorization: r?.prior_authorization ?? null, stepTherapy: r?.step_therapy ?? null,
        quantityLimit: { applies: r?.quantity_limit ?? null, amount: r?.quantity_limit ? r.quantity_limit_amount : null, days: r?.quantity_limit ? r.quantity_limit_days : null },
        capturedAt: input.capturedAt, effectiveAt: input.effectiveAt, rawArtifactHash: digest, provenance: input.provenance };
      validateObservation(o);
      const serialized = JSON.stringify(o);
      if (seen.has(key)) { if (seen.get(key) !== serialized) throw new Error("Conflicting duplicate entry"); return; }
      seen.set(key, serialized);
      observations.push(o);
    } catch (error) { quarantine.push({ locator: `entries[${index}]`, reason: (error as Error).message }); }
  });
  for (const key of expectedKeys) if (!seen.has(key)) quarantine.push({ locator: key, reason: "Missing explicit coverage observation" });
  const run: SourceRun = { id: runId, source: "cms_monthly", capturedAt: input.capturedAt, expectedKeys, status: quarantine.length ? "failed" : "completed", quarantine };
  await persistRun(db, run, observations);
  return { run, observations };
}
