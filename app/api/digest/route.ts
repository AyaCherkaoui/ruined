import { errorResponse } from "../../../lib/http";
import { buildDigest } from "../../../lib/digest";

export const dynamic = "force-dynamic";

// GET /api/digest -> Digest (dismissed alerts excluded; totalAtRisk = status new|seen)
export async function GET() {
  try {
    return Response.json(await buildDigest());
  } catch (err) {
    return errorResponse(err);
  }
}
