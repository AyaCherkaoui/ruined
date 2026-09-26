import type { Digest } from "./contract";
import { getDb, type Db } from "./db";
import { buildPatientAlerts, resolveChangeSource, type ChangeSource } from "./patientAlerts";
import { round2 } from "./coverage";

/**
 * GET /api/digest: the doctor's inbox. Dismissed alerts are hidden entirely (the doctor decided
 * they don't matter); everything else is shown so a "switched" or "patient_notified" alert stays
 * visible as a record of what was done. totalAtRisk only counts "new"/"seen" -- per the contract,
 * not alerts already acted on.
 */
export async function buildDigest(db?: Db, source: ChangeSource = resolveChangeSource()): Promise<Digest> {
  const conn = db ?? (await getDb());
  const alerts = (await buildPatientAlerts(conn, source)).filter((a) => a.status !== "dismissed");

  const totalAtRisk = alerts.filter((a) => a.status === "new" || a.status === "seen").length;
  const totalMonthlyIncrease = round2(alerts.reduce((sum, a) => sum + (a.monthlyIncrease ?? 0), 0));
  const totalMonthlySavingsIfSwitched = round2(alerts.reduce((sum, a) => sum + (a.bestAlternative?.monthlySavings ?? 0), 0));

  return {
    totalAtRisk,
    totalMonthlyIncrease,
    totalMonthlySavingsIfSwitched,
    alerts, // buildPatientAlerts already sorts by monthlyIncrease desc; filtering preserves order
    generatedAt: new Date().toISOString(),
  };
}
