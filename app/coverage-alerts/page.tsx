import { CoverageWatchdog } from "@/components/coverage-watchdog";
import { listAlerts } from "@/lib/coverageAlerts";

export const dynamic = "force-dynamic";

export default async function CoverageAlertsPage() {
  const alerts = await listAlerts();
  return <CoverageWatchdog alerts={alerts} />;
}
