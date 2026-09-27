import { listAlerts } from "../../../lib/coverageAlerts";
import { errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await listAlerts());
  } catch (err) {
    return errorResponse(err);
  }
}
