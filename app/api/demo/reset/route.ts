import { resetAlerts } from "../../../../lib/coverageAlerts";
import { errorResponse } from "../../../../lib/http";
import { resetAlertStatuses } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    // Coverage Watchdog alerts first: they don't need the database, so they reopen even if
    // the legacy NovoLog reset below fails.
    await resetAlerts();
    return Response.json(await resetAlertStatuses());
  } catch (err) {
    return errorResponse(err);
  }
}
