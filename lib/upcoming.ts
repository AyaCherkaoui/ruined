import { findAlternatives } from "./alternatives";
import type { UpcomingRisk } from "./contract";
import { findAdverseChanges, NEXT_DATA_VERSION } from "./changes";
import { DEFAULT_DATA_VERSION, round2 } from "./coverage";
import { getDb, type Db } from "./db";
import { displayDrugName } from "./display";

// GET /api/upcoming: per-patient view of the same v1 -> v2 adverse changes /api/alerts reports,
// enriched for a "fix it before it hits" workflow: the patient's age/language (for outreach),
// the percent increase, the change's effective date, and the best switch available under the
// UPCOMING (v2) rules -- what the doctor should move the patient to now, before the tier hike lands.

// v2 is a SYNTHETIC change-tracker copy (scripts/make-v2.ts, see PROGRESS.md Task 8); it carries no
// real effective date, so this is invented for the demo and documented as an assumption.
export const UPCOMING_EFFECTIVE_DATE = "2027-01-01";

export async function buildUpcomingRisks(db?: Db, from = DEFAULT_DATA_VERSION, to = NEXT_DATA_VERSION): Promise<UpcomingRisk[]> {
  const conn = db ?? (await getDb());
  const changes = await findAdverseChanges(conn, from, to);

  const risks: UpcomingRisk[] = [];
  for (const { patient, rxcui, oldCoverage: o, newCoverage: n } of changes) {
    const [bestAlternative] = await findAlternatives(patient.plan, rxcui, { db: conn, dataVersion: to, limit: 1 });
    const percentIncrease =
      o.estMonthlyCost !== null && n.estMonthlyCost !== null && o.estMonthlyCost > 0
        ? round2(((n.estMonthlyCost - o.estMonthlyCost) / o.estMonthlyCost) * 100)
        : null;

    risks.push({
      patientId: patient.id,
      patientName: patient.name,
      age: patient.age,
      language: patient.language,
      rxcui,
      drugName: n.drugName,
      displayName: displayDrugName(n.drugName),
      oldTier: o.tier,
      newTier: n.tier,
      oldMonthlyCost: o.estMonthlyCost,
      newMonthlyCost: n.estMonthlyCost,
      percentIncrease,
      effectiveDate: UPCOMING_EFFECTIVE_DATE,
      bestAlternative: bestAlternative ?? null,
    });
  }

  const increase = (r: UpcomingRisk) => (r.newMonthlyCost ?? 0) - (r.oldMonthlyCost ?? 0);
  return risks.sort((a, b) => increase(b) - increase(a) || a.patientName.localeCompare(b.patientName) || a.drugName.localeCompare(b.drugName));
}
