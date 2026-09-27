import type { CoverageChange } from "../contract";
import { getDb, inTransaction, type Db } from "../db";
import { ApiError } from "../http";
import { CURRENT_DATA_VERSION, PREVIOUS_DATA_VERSION } from "../scenario";
import { detectChanges } from "./detectChanges";
import { matchPrescriptions } from "./matchPrescriptions";

const RXCUI = "1653204";
// Serialize runs in this server process, including development hot reloads.
const state = globalThis as unknown as { __demoPipelineRun?: Promise<unknown> };

export async function runAppPipeline(db?: Db) {
  if (state.__demoPipelineRun) throw new ApiError(409, "The demo pipeline is already running.");
  const pending = (async () => {
    const database = db ?? await getDb();
    return inTransaction(database, async (conn) => {
    for (const version of [PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION]) {
      for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
        const [row] = await conn.query<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE data_version=$1`, [version]);
        if (!row.n) throw new ApiError(503, `Demo release ${version} is missing ${table}. Run the CMS bootstrap first.`);
      }
      const incomplete = await conn.query(`SELECT 1 FROM plans p JOIN patient_coverage pc
        ON p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id
        JOIN prescriptions pr ON pr.patient_id=pc.patient_id
        WHERE p.data_version=$1 AND pr.rxcui=$2 AND NOT EXISTS
          (SELECT 1 FROM formulary f WHERE f.data_version=p.data_version AND f.formulary_id=p.formulary_id) LIMIT 1`, [version, RXCUI]);
      if (incomplete.length) throw new ApiError(503, `A demo formulary is missing from ${version}. Rebuild the CMS inputs before running.`);
    }
    // An incomplete plan mapping must not manufacture coverage-loss notifications.
    const missing = await conn.query(`SELECT 1 FROM prescriptions pr
      LEFT JOIN patient_coverage pc ON pc.patient_id=pr.patient_id
      WHERE pr.rxcui=$1 AND (pc.patient_id IS NULL OR NOT EXISTS (SELECT 1 FROM plans p WHERE p.data_version=$2
        AND p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id)
      OR NOT EXISTS (SELECT 1 FROM plans p WHERE p.data_version=$3
        AND p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id)) LIMIT 1`,
    [RXCUI, PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION]);
    if (missing.length) throw new ApiError(503, "A demo patient's plan is missing from a release. Rebuild the CMS inputs before running.");
    const prescriptions = await conn.query("SELECT 1 FROM prescriptions WHERE rxcui=$1 LIMIT 1", [RXCUI]);
    if (!prescriptions.length) throw new ApiError(503, "The NovoLog demo has no prescriptions. Seed the scenario first.");
    const missingBaseline = await conn.query(`SELECT 1 FROM prescriptions pr
      JOIN patient_coverage pc ON pc.patient_id=pr.patient_id
      JOIN plans p ON p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id
      WHERE pr.rxcui=$1 AND p.data_version=$2 AND NOT EXISTS
        (SELECT 1 FROM formulary f WHERE f.data_version=p.data_version
          AND f.formulary_id=p.formulary_id AND f.rxcui=pr.rxcui) LIMIT 1`, [RXCUI, PREVIOUS_DATA_VERSION]);
    if (missingBaseline.length) throw new ApiError(503, "NovoLog is missing from a demo patient's baseline formulary. Rebuild the baseline before running.");
    const changes = await detectChanges(PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION, [RXCUI], conn);
    const alerts = await matchPrescriptions(changes.map((c) => c.id), conn);
    return { fromVersion: PREVIOUS_DATA_VERSION, toVersion: CURRENT_DATA_VERSION, rxcui: RXCUI,
      changeIds: changes.map((c) => c.id).sort(), alertIds: alerts.map((a) => a.id).sort(),
      changes: changes.length, alerts: alerts.length };
    });
  })();
  state.__demoPipelineRun = pending;
  try { return await pending; }
  finally { state.__demoPipelineRun = undefined; }
}

/** Read persisted facts without invoking detection or changing review state. */
export async function listAppChanges(db?: Db): Promise<CoverageChange[]> {
  const conn = db ?? await getDb();
  return conn.query<CoverageChange>(`SELECT c.id, c.from_version AS "fromVersion", c.to_version AS "toVersion",
    c.formulary_id AS "formularyId", c.rxcui, coalesce(d.name,c.rxcui) AS "drugName",
    c.change_type AS "changeType", c.old_tier AS "oldTier", c.new_tier AS "newTier",
    c.old_pa AS "oldPriorAuth", c.new_pa AS "newPriorAuth", c.old_st AS "oldStepTherapy",
    c.new_st AS "newStepTherapy", c.old_ql AS "oldQuantityLimit", c.new_ql AS "newQuantityLimit",
    c.detected_at AS "detectedAt" FROM coverage_changes c LEFT JOIN drugs d ON d.rxcui=c.rxcui
    WHERE c.from_version=$1 AND c.to_version=$2 AND c.rxcui=$3 ORDER BY c.id`,
  [PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION, RXCUI]);
}
