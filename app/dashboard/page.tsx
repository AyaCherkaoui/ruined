import { Dashboard } from "@/components/dashboard";
import { alertsForDoctor, countPatients } from "@/lib/queries";
import { DEMO_DOCTOR_ID } from "@/lib/scenario";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [alerts, totalPatients] = await Promise.all([
    alertsForDoctor(DEMO_DOCTOR_ID),
    countPatients(),
  ]);
  return <Dashboard alerts={alerts} totalPatients={totalPatients} />;
}
