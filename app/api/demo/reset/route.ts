import { errorResponse } from "../../../../lib/http";
import { resetAlertStatuses } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return Response.json(await resetAlertStatuses());
  } catch (err) {
    return errorResponse(err);
  }
}
