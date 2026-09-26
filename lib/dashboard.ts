import { findAlternatives } from "./alternatives";
import type { Alternative, CoverageResult, DashboardResponse } from "./contract";
import { coverageForRxcuis, loadPlanContext, round2 } from "./coverage";
import { getDb, type Db } from "./db";
import { listPatients } from "./patients";

/** A med is "overpaying" if a covered alternative would save at least this much per month... */
export const OVERPAYING_MIN_SAVINGS = 10;
/** ...or if the patient's estimated monthly cost for it is this high, even when no cheaper alternative exists. */
export const HIGH_COST_MIN = 100;

/**
 * Roster-level view: which patients are likely overpaying, and how much could they save?
 *
 * Every med on the patient's plan is checked and paired with its best cheaper alternative. A med is flagged if
 *  - the plan does not cover it at all (the patient would pay full price), or
 *  - an alternative saves >= OVERPAYING_MIN_SAVINGS per month, or
 *  - it costs the patient >= HIGH_COST_MIN per month (bestAlternative is then null if nothing cheaper exists).
 * A patient is at risk if any med is flagged. `worstDrug` is chosen among the FLAGGED meds only (so a $1 saving on a
 * generic can never hide a $265 drug): not-covered first, then largest saving, then highest cost; `bestAlternative`
 * is that drug's top alternative. totalPotentialMonthlySavings sums the shown bestAlternative savings, so it
 * always matches what the UI lists.
 */
export async function buildDashboard(db?: Db): Promise<DashboardResponse> {
  const conn = db ?? (await getDb());
  const patients = await listPatients(conn);
  const atRisk: DashboardResponse["atRisk"] = [];

  for (const patient of patients) {
    if (patient.meds.length === 0) continue;
    const ctx = await loadPlanContext(conn, patient.plan);
    const coverage = await coverageForRxcuis(conn, ctx, patient.meds.map((m) => m.rxcui));

    const rows: { drug: CoverageResult; alt: Alternative | null }[] = [];
    for (const med of patient.meds) {
      const drug = coverage.get(med.rxcui)!;
      const [alt] = await findAlternatives(patient.plan, med.rxcui, { db: conn, limit: 1 });
      rows.push({ drug, alt: alt ?? null });
    }

    const flagged = rows.filter(
      ({ drug, alt }) =>
        drug.status === "not_covered" ||
        (alt !== null && alt.monthlySavings >= OVERPAYING_MIN_SAVINGS) ||
        (drug.estMonthlyCost ?? 0) >= HIGH_COST_MIN,
    );
    if (flagged.length === 0) continue;

    const severity = ({ drug, alt }: (typeof rows)[number]) =>
      drug.status === "not_covered" ? Infinity : alt && alt.monthlySavings >= OVERPAYING_MIN_SAVINGS ? alt.monthlySavings : 0;
    flagged.sort(
      (a, b) =>
        severity(b) - severity(a) ||
        (b.drug.estMonthlyCost ?? 0) - (a.drug.estMonthlyCost ?? 0) ||
        a.drug.drugName.localeCompare(b.drug.drugName),
    );
    const worst = flagged[0];
    atRisk.push({ patient, worstDrug: worst.drug, bestAlternative: worst.alt });
  }

  atRisk.sort(
    (a, b) =>
      (b.bestAlternative?.monthlySavings ?? 0) - (a.bestAlternative?.monthlySavings ?? 0) ||
      a.patient.name.localeCompare(b.patient.name),
  );
  return {
    totalPatients: patients.length,
    patientsOverpaying: atRisk.length,
    totalPotentialMonthlySavings: round2(atRisk.reduce((s, r) => s + (r.bestAlternative?.monthlySavings ?? 0), 0)),
    atRisk,
  };
}
