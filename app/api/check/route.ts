import { runCheck, type CheckRequest } from "../../../lib/check";
import { ApiError, errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

// POST /api/check  body: { patientId | contractId+planId[+segmentId], rxcui | drugName }  -> CheckResponse
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError(400, "Body must be a JSON object");
    }
    return Response.json(await runCheck(body as CheckRequest));
  } catch (err) {
    return errorResponse(err);
  }
}
