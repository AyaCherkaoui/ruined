import { ApiError, errorResponse } from "../../../lib/http";
import { runInsurerCheck, type CheckRequest } from "../../../lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    return Response.json(await runInsurerCheck(body as CheckRequest), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
