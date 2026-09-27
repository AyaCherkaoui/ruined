import { notFound } from "next/navigation";
import { PatientReview } from "@/components/patient-review";
import type { CheckResponse } from "@/lib/contract";
import { alertById, runCheck } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ alertId: string }> }) {
  const { alertId } = await params;
  const alert = await alertById(alertId);
  if (!alert) notFound();

  let check: CheckResponse | null = null;
  let checkError: string | null = null;
  try {
    check = await runCheck({ patientId: alert.patientId, rxcui: alert.rxcui });
  } catch (err: unknown) {
    checkError = err instanceof Error ? err.message : "Unable to load suggested alternatives.";
  }

  return <PatientReview alert={alert} check={check} checkError={checkError} />;
}
