import { requestCoverageAlertStore } from "../../../../lib/coverageAlerts";
import { errorResponse } from "../../../../lib/http";
import { resetAlertStatuses } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const store = await requestCoverageAlertStore();
    // Validate the selected source before changing either workflow. Reset its state only
    // after the legacy database update succeeds, so DB failures preserve review state.
    await store.list();
    const result = await resetAlertStatuses();
    await store.reset();
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
