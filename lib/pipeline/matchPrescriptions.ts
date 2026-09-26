import crypto from "node:crypto";
import { findAlternatives } from "../alternatives";
import { checkCoverage } from "../coverage";
import { getDb, type Db } from "../db";

// For each coverage_change, finds every prescription for that rxcui whose patient's plan uses
// the affected formulary, and writes a patient_alerts row. Costs and the suggested switch come
// straight from checkCoverage/findAlternatives -- the existing, tested deterministic engine --
// never recomputed here. See DATA_MODEL.md.

export interface MatchedAlert {
  id: string;
  changeId: string;
  patientId: string;
  prescriptionId: string;
  contractId: string;
  planId: string;
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
  bestAlternativeRxcui: string | null;
  bestAlternativeCost: number | null;
  status: "new";
  createdAt: string;
}

interface ChangeRow {
  id: string;
  from_version: string;
  to_version: string;
  formulary_id: string;
  rxcui: string;
}

interface PrescriptionMatch {
  id: string;
  patient_id: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
}

interface AlertDbRow {
  id: string;
  change_id: string;
  patient_id: string;
  prescription_id: string;
  contract_id: string;
  plan_id: string;
  old_monthly_cost: number | null;
  new_monthly_cost: number | null;
  best_alternative_rxcui: string | null;
  best_alternative_cost: number | null;
  status: "new";
  created_at: string;
}

/** Deterministic id from the natural key, so re-matching never duplicates a row. */
function alertId(changeId: string, prescriptionId: string): string {
  return crypto.createHash("sha1").update(`${changeId}:${prescriptionId}`).digest("hex").slice(0, 20);
}

const toDto = (r: AlertDbRow): MatchedAlert => ({
  id: r.id,
  changeId: r.change_id,
  patientId: r.patient_id,
  prescriptionId: r.prescription_id,
  contractId: r.contract_id,
  planId: r.plan_id,
  oldMonthlyCost: r.old_monthly_cost,
  newMonthlyCost: r.new_monthly_cost,
  bestAlternativeRxcui: r.best_alternative_rxcui,
  bestAlternativeCost: r.best_alternative_cost,
  status: r.status,
  createdAt: r.created_at,
});

export async function matchPrescriptions(changeIds: string[], db?: Db): Promise<MatchedAlert[]> {
  const conn = db ?? (await getDb());
  if (changeIds.length === 0) return [];

  const changes = await conn.query<ChangeRow>(
    `SELECT id, from_version, to_version, formulary_id, rxcui FROM coverage_changes
      WHERE id IN (${changeIds.map((_, i) => `$${i + 1}`).join(", ")})`,
    changeIds,
  );

  const candidateIds: string[] = [];
  for (const change of changes) {
    // The patient's CURRENT plan (patient_coverage carries no version) must point at the
    // affected formulary as of `to_version` -- that's what determines whether the change
    // actually reaches them.
    const matches = await conn.query<PrescriptionMatch>(
      `SELECT p.id, p.patient_id, pc.contract_id, pc.plan_id, pc.segment_id
         FROM prescriptions p
         JOIN patient_coverage pc ON pc.patient_id = p.patient_id
         JOIN plans pl ON pl.data_version = $1 AND pl.contract_id = pc.contract_id
                      AND pl.plan_id = pc.plan_id AND pl.segment_id = pc.segment_id
        WHERE p.rxcui = $2 AND pl.formulary_id = $3`,
      [change.to_version, change.rxcui, change.formulary_id],
    );

    for (const rx of matches) {
      const id = alertId(change.id, rx.id);
      candidateIds.push(id);
      const existing = await conn.query<{ id: string }>("SELECT id FROM patient_alerts WHERE id = $1", [id]);
      if (existing.length > 0) continue;

      const plan = { contractId: rx.contract_id, planId: rx.plan_id, segmentId: rx.segment_id };
      const oldCoverage = await checkCoverage(plan.contractId, plan.planId, plan.segmentId, change.rxcui, { db: conn, dataVersion: change.from_version });
      const newCoverage = await checkCoverage(plan.contractId, plan.planId, plan.segmentId, change.rxcui, { db: conn, dataVersion: change.to_version });
      const alternatives = await findAlternatives(plan, change.rxcui, { db: conn, dataVersion: change.to_version });
      const best = alternatives[0] ?? null;

      await conn.run(
        `INSERT INTO patient_alerts (id, change_id, patient_id, prescription_id, contract_id, plan_id,
            old_monthly_cost, new_monthly_cost, best_alternative_rxcui, best_alternative_cost, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',CURRENT_TIMESTAMP)`,
        [
          id,
          change.id,
          rx.patient_id,
          rx.id,
          plan.contractId,
          plan.planId,
          oldCoverage.estMonthlyCost,
          newCoverage.estMonthlyCost,
          best?.rxcui ?? null,
          best?.estMonthlyCost ?? null,
        ],
      );
    }
  }
  if (candidateIds.length === 0) return [];

  const rows = await conn.query<AlertDbRow>(
    `SELECT * FROM patient_alerts WHERE id IN (${candidateIds.map((_, i) => `$${i + 1}`).join(", ")}) ORDER BY patient_id`,
    candidateIds,
  );
  return rows.map(toDto);
}
