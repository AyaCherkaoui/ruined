import { buildAlerts } from "../../../lib/changes";
import { errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

// GET /api/alerts -> CoverageAlert[]  (formulary changes v1 -> v2 that hit our patients)
export async function GET() {
  try {
    return Response.json(await buildAlerts());
  } catch (err) {
    return errorResponse(err);
  }
}
