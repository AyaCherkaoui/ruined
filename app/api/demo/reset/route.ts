import { errorResponse } from "../../../../lib/http";
import { resetAllAlertStatuses } from "../../../../lib/alertStatus";

export const dynamic = "force-dynamic";

// POST /api/demo/reset -> { reset: true }  (every alert status back to "new", for replaying the demo)
export async function POST() {
  try {
    await resetAllAlertStatuses();
    return Response.json({ reset: true });
  } catch (err) {
    return errorResponse(err);
  }
}
