import { requireUser } from "../../../../lib/auth";
import { ApiError, errorResponse } from "../../../../lib/http";
import { authorizeSms } from "../../../../lib/sms-notifications";
import { runAppPipeline } from "../../../../lib/pipeline/app-runner";
import { notifyPolicyChanges, policyDeliveryStatus } from "../../../../lib/pipeline/policy-notification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = await request.json().catch(() => { throw new ApiError(400, "Body must be JSON."); });
    if (!body || !["preview", "send", "status"].includes(body.action)) throw new ApiError(400, "Choose preview, send, or status.");
    if (body.action !== "preview") authorizeSms(request);
    if (body.action === "status") {
      if (typeof body.receiptId !== "string") throw new ApiError(400, "receiptId is required.");
      return Response.json({ notification: await policyDeliveryStatus(body.receiptId) });
    }
    const pipeline = await runAppPipeline();
    return Response.json({ pipeline, ...await notifyPolicyChanges(body.action === "preview") });
  } catch (error) { return errorResponse(error); }
}
