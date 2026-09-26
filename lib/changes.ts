import type { CoverageAlert } from "./contract";
import { coverageForRxcuis, DEFAULT_DATA_VERSION, loadPlanContext } from "./coverage";
import { getDb, type Db } from "./db";
import { listPatients } from "./patients";

// Change tracker: what moved between two loaded versions of the formulary, and which patients it hits.

export const NEXT_DATA_VERSION = "v2";

export interface FormularyChange {
  formularyId: string;
  rxcui: string;
  oldTier: number;
  newTier: number;
}

/** Every (formulary, drug) whose tier differs between the two versions. */
export async function diffFormularies(db: Db, from = DEFAULT_DATA_VERSION, to = NEXT_DATA_VERSION): Promise<FormularyChange[]> {
  const rows = await db.query<{ formulary_id: string; rxcui: string; old_tier: number; new_tier: number }>(
    `SELECT a.formulary_id, a.rxcui, a.tier AS old_tier, b.tier AS new_tier
       FROM formulary a
       JOIN formulary b ON b.data_version = $2 AND b.formulary_id = a.formulary_id AND b.rxcui = a.rxcui
      WHERE a.data_version = $1 AND a.tier <> b.tier
      ORDER BY a.formulary_id, a.rxcui`,
    [from, to],
  );
  return rows.map((r) => ({ formularyId: r.formulary_id, rxcui: r.rxcui, oldTier: r.old_tier, newTier: r.new_tier }));
}

/**
 * Alerts for patients whose meds got worse: the drug moved to a higher tier, or its estimated
 * monthly cost went up. Largest cost increase first. (The alert shape carries tiers, so removals and
 * new PA / step-therapy rules are not represented here.)
 */
export async function buildAlerts(db?: Db, from = DEFAULT_DATA_VERSION, to = NEXT_DATA_VERSION): Promise<CoverageAlert[]> {
  const conn = db ?? (await getDb());
  const changes = await diffFormularies(conn, from, to);
  if (changes.length === 0) return [];
  const changed = new Map(changes.map((c) => [`${c.formularyId}:${c.rxcui}`, c]));

  const alerts: CoverageAlert[] = [];
  for (const patient of await listPatients(conn)) {
    const before = await loadPlanContext(conn, patient.plan, from);
    const after = await loadPlanContext(conn, patient.plan, to);
    const hit = patient.meds.filter((m) => changed.has(`${before.formularyId}:${m.rxcui}`));
    if (hit.length === 0) continue;

    const oldCov = await coverageForRxcuis(conn, before, hit.map((m) => m.rxcui));
    const newCov = await coverageForRxcuis(conn, after, hit.map((m) => m.rxcui));
    for (const med of hit) {
      const o = oldCov.get(med.rxcui)!;
      const n = newCov.get(med.rxcui)!;
      if (o.tier === null || n.tier === null) continue;
      const worse = n.tier > o.tier || (n.estMonthlyCost ?? 0) > (o.estMonthlyCost ?? 0);
      if (!worse) continue;
      alerts.push({
        patientId: patient.id,
        patientName: patient.name,
        drugName: n.drugName,
        oldTier: o.tier,
        newTier: n.tier,
        oldMonthlyCost: o.estMonthlyCost,
        newMonthlyCost: n.estMonthlyCost,
      });
    }
  }
  const increase = (a: CoverageAlert) => (a.newMonthlyCost ?? 0) - (a.oldMonthlyCost ?? 0);
  return alerts.sort((a, b) => increase(b) - increase(a) || a.patientName.localeCompare(b.patientName) || a.drugName.localeCompare(b.drugName));
}
