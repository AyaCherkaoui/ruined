import { MedishiftDashboard, type DashboardItem } from "@/components/medishift-dashboard";
import { findAlternatives } from "@/lib/alternatives";
import { alertsForDoctor } from "@/lib/queries";
import { CURRENT_DATA_VERSION, DEMO_DOCTOR_ID } from "@/lib/scenario";

export const dynamic = "force-dynamic";

export default async function Home() {
  const alerts = await alertsForDoctor(DEMO_DOCTOR_ID);
  const items: DashboardItem[] = [];
  for (const alert of alerts) {
    try {
      const alternatives = await findAlternatives(
        { contractId: alert.contractId, planId: alert.planId, segmentId: alert.segmentId },
        alert.rxcui,
        { dataVersion: CURRENT_DATA_VERSION },
      );
      items.push({ alert, alternatives, checkError: null });
    } catch (err: unknown) {
      items.push({
        alert,
        alternatives: [],
        checkError: err instanceof Error ? err.message : "Unable to load formulary alternatives.",
      });
    }
  }
  return <MedishiftDashboard items={items} />;
}
