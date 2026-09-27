import { ApiError, errorResponse } from "../../../lib/http";
import { authorizeSms, notifyAlert } from "../../../lib/sms-notifications";
import { liveSmsConfigured } from "../../../lib/twilio";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ mode: liveSmsConfigured() ? "live" : "preview" }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    let input: unknown;
    try { input = await request.json(); } catch { throw new ApiError(400, "Expected a JSON request."); }
    if (!input || typeof input !== "object") throw new ApiError(400, "An alert id is required.");
    const { changeId, preview } = input as Record<string, unknown>;
    if (typeof changeId !== "string" || !changeId.trim() || changeId.length > 200 || (preview !== undefined && typeof preview !== "boolean")) {
      throw new ApiError(400, "Provide a valid alert id and preview flag.");
    }
    if (preview !== true && liveSmsConfigured()) authorizeSms(request);
    return Response.json(await notifyAlert(changeId, preview === true), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
