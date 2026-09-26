import { buildDashboard } from "../../../lib/dashboard";
import { errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

// GET /api/dashboard -> DashboardResponse
export async function GET() {
  try {
    return Response.json(await buildDashboard());
  } catch (err) {
    return errorResponse(err);
  }
}
