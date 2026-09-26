import { errorResponse } from "../../../lib/http";
import { buildUpcomingRisks } from "../../../lib/upcoming";

export const dynamic = "force-dynamic";

// GET /api/upcoming -> UpcomingRisk[]  (v1 -> v2 adverse changes per patient, with the v2-rules
// alternative to switch to before the change hits; sorted by dollar increase)
export async function GET() {
  try {
    return Response.json(await buildUpcomingRisks());
  } catch (err) {
    return errorResponse(err);
  }
}
