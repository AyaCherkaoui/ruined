import { AlertInbox } from "@/components/alert-inbox";
import { alertsForDoctor } from "@/lib/queries";
import { DEMO_DOCTOR_ID } from "@/lib/scenario";

export const dynamic = "force-dynamic";

export default async function Home() {
  const alerts = await alertsForDoctor(DEMO_DOCTOR_ID);
  return <AlertInbox alerts={alerts} />;
}
