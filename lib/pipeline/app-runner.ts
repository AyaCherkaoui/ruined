import type { CoverageChange } from "../contract";
import { getDb, inTransaction, type Db } from "../db";
import { ApiError } from "../http";
import { CURRENT_DATA_VERSION, PREVIOUS_DATA_VERSION, DEMO_DOCTOR_ID } from "../scenario";
import { detectChanges } from "./detectChanges";
import { matchPrescriptions } from "./matchPrescriptions";
import { hostedDemoEnabled, hostedReplay, hostedChanges } from "../hostedDemo";

// Serialize runs in this server process, including development hot reloads.
const state = globalThis as unknown as { __demoPipelineRun?: Promise<unknown> };

export async function runAppPipeline(db?: Db) {
  if (!db && hostedDemoEnabled()) return hostedReplay();
  if (state.__demoPipelineRun) throw new ApiError(409, "The demo pipeline is already running.");
  const pending = (async () => {
    const database = db ?? await getDb();
    return inTransaction(database, async (conn) => {
      const drugs = await conn.query<{ rxcui: string }>("SELECT DISTINCT rxcui FROM prescriptions WHERE doctor_id=$1 ORDER BY rxcui", [DEMO_DOCTOR_ID]);
      if (!drugs.length) throw new ApiError(503, "The demo has no prescriptions. Run npm run demo:seed first.");
      const allChanges = new Set<string>();
      const allAlerts = new Set<string>();
      for (const { rxcui } of drugs) {
        for (const version of [PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION]) {
          for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
            const [row] = await conn.query<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE data_version=$1`, [version]);
            if (!row.n) throw new ApiError(503, `Demo release ${version} is missing ${table}. Run the CMS bootstrap first.`);
          }
          const incomplete = await conn.query(`SELECT 1 FROM plans p JOIN patient_coverage pc
            ON p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id
            JOIN prescriptions pr ON pr.patient_id=pc.patient_id
            WHERE p.data_version=$1 AND pr.rxcui=$2 AND pr.doctor_id='doc-001' AND NOT EXISTS
              (SELECT 1 FROM formulary f WHERE f.data_version=p.data_version AND f.formulary_id=p.formulary_id) LIMIT 1`, [version, rxcui]);
          if (incomplete.length) throw new ApiError(503, `A demo formulary is missing from ${version}. Rebuild the CMS inputs before running.`);
        }
        // An incomplete plan mapping must not manufacture coverage-loss notifications.
        const missing = await conn.query(`SELECT 1 FROM prescriptions pr
          LEFT JOIN patient_coverage pc ON pc.patient_id=pr.patient_id
          WHERE pr.doctor_id='doc-001' AND pr.rxcui=$1 AND (pc.patient_id IS NULL OR NOT EXISTS (SELECT 1 FROM plans p WHERE p.data_version=$2
            AND p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id)
          OR NOT EXISTS (SELECT 1 FROM plans p WHERE p.data_version=$3
            AND p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id)) LIMIT 1`,
        [rxcui, PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION]);
        if (missing.length) throw new ApiError(503, "A demo patient's plan is missing from a release. Rebuild the CMS inputs before running.");
        const missingBaseline = await conn.query(`SELECT 1 FROM prescriptions pr
          JOIN patient_coverage pc ON pc.patient_id=pr.patient_id
          JOIN plans p ON p.contract_id=pc.contract_id AND p.plan_id=pc.plan_id AND p.segment_id=pc.segment_id
          WHERE pr.doctor_id='doc-001' AND pr.rxcui=$1 AND p.data_version=$2 AND NOT EXISTS
            (SELECT 1 FROM formulary f WHERE f.data_version=p.data_version
              AND f.formulary_id=p.formulary_id AND f.rxcui=pr.rxcui) LIMIT 1`, [rxcui, PREVIOUS_DATA_VERSION]);
        if (missingBaseline.length) throw new ApiError(503, "A prescribed drug is missing from a demo patient's baseline formulary. Rebuild the baseline before running.");
        const changes = await detectChanges(PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION, [rxcui], conn);
        const alerts = await matchPrescriptions(changes.map((c) => c.id), conn);
        const ownedAlerts = await conn.query<{ id: string }>("SELECT a.id FROM patient_alerts a JOIN prescriptions p ON p.id=a.prescription_id WHERE p.doctor_id=$1", [DEMO_DOCTOR_ID]);
        const owned = new Set(ownedAlerts.map(a => a.id));
        for (const alert of alerts) if (owned.has(alert.id)) { allAlerts.add(alert.id); allChanges.add(alert.changeId); }
      }
      return { fromVersion: PREVIOUS_DATA_VERSION, toVersion: CURRENT_DATA_VERSION, rxcuis: drugs.map(d => d.rxcui),
        changeIds: [...allChanges].sort(), alertIds: [...allAlerts].sort(),
        changes: allChanges.size, alerts: allAlerts.size };
    });
  })();
  state.__demoPipelineRun = pending;
  try { return await pending; }
  finally { state.__demoPipelineRun = undefined; }
}

/** Read persisted facts without invoking detection or changing review state. */
export async function listAppChanges(db?: Db): Promise<CoverageChange[]> {
  if (!db && hostedDemoEnabled()) return hostedChanges();
  const conn = db ?? await getDb();
  return conn.query<CoverageChange>(`SELECT c.id, c.from_version AS "fromVersion", c.to_version AS "toVersion",
    c.formulary_id AS "formularyId", c.rxcui, coalesce(d.name,c.rxcui) AS "drugName",
    c.change_type AS "changeType", c.old_tier AS "oldTier", c.new_tier AS "newTier",
    c.old_pa AS "oldPriorAuth", c.new_pa AS "newPriorAuth", c.old_st AS "oldStepTherapy",
    c.new_st AS "newStepTherapy", c.old_ql AS "oldQuantityLimit", c.new_ql AS "newQuantityLimit",
    c.detected_at AS "detectedAt" FROM coverage_changes c LEFT JOIN drugs d ON d.rxcui=c.rxcui
    WHERE c.from_version=$1 AND c.to_version=$2 AND EXISTS (SELECT 1 FROM patient_alerts a JOIN prescriptions p ON p.id=a.prescription_id WHERE a.change_id=c.id AND p.doctor_id=$3) ORDER BY c.id`,
  [PREVIOUS_DATA_VERSION, CURRENT_DATA_VERSION, DEMO_DOCTOR_ID]);
}
