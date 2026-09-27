import { DrugCoverageDashboard } from "@/components/drug-coverage-dashboard";
import type { CheckResponse } from "@/lib/contract";
import { buildDrugPlanRows } from "@/lib/drug-coverage-view";
import { listAppChanges } from "@/lib/pipeline/app-runner";
import { alertsForDoctor, runCheck } from "@/lib/queries";
import { DEMO_DOCTOR_ID } from "@/lib/scenario";

export const dynamic = "force-dynamic";

// Drugs x insurance plans only. Patient matches stay on the server: they are used for the
// aggregate count and the WhatsApp alert, and are never sent to the browser.
export default async function Home() {
  const [alerts, changes] = await Promise.all([alertsForDoctor(DEMO_DOCTOR_ID), listAppChanges()]);
  const checks = new Map<string, CheckResponse | null>();
  for (const alert of alerts) {
    const key = `${alert.contractId}:${alert.planId}:${alert.segmentId}:${alert.rxcui}`;
    if (checks.has(key)) continue;
    try {
      checks.set(key, await runCheck({ contractId: alert.contractId, planId: alert.planId, segmentId: alert.segmentId, rxcui: alert.rxcui }));
    } catch {
      checks.set(key, null);
    }
  }
  const groups = buildDrugPlanRows(alerts, changes, checks);
  const affectedPatients = new Set(alerts.map((a) => a.patientId)).size;
  return <DrugCoverageDashboard groups={groups} affectedPatients={affectedPatients} />;
}
