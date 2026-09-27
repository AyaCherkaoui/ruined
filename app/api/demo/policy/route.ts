import { requireUser } from "../../../../lib/auth";
import { ApiError, errorResponse } from "../../../../lib/http";
import { authorizeSms } from "../../../../lib/sms-notifications";
import { runAppPipeline } from "../../../../lib/pipeline/app-runner";
import { notifyPolicyChanges, policyDeliveryStatus } from "../../../../lib/pipeline/policy-notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireUser();
    const body = await request.json().catch(() => { throw new ApiError(400, "Body must be JSON."); });
    if (!body || !["preview", "send", "status", "alert"].includes(body.action)) throw new ApiError(400, "Choose preview, send, status, or alert.");
    // "alert" is the one-click demo: a signed-in doctor sends with the server-side messaging
    // secrets, no access key. It needs real sign-in, so it is refused when auth is off.
    if (body.action === "alert" && !session) throw new ApiError(403, "One-click alerts need Supabase sign-in configured.");
    if (body.action === "send" || body.action === "status") authorizeSms(request);
    if (body.action === "status") {
      if (typeof body.receiptId !== "string") throw new ApiError(400, "receiptId is required.");
      return Response.json({ notification: await policyDeliveryStatus(body.receiptId) });
    }
    const pipeline = await runAppPipeline();
    if (body.action === "alert") return Response.json({ pipeline, ...await notifyPolicyChanges(false, undefined, process.env, fetch, { repeat: true }) });
    return Response.json({ pipeline, ...await notifyPolicyChanges(body.action === "preview") });
  } catch (error) { return errorResponse(error); }
}
