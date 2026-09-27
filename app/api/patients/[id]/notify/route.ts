import { ApiError, errorResponse } from "../../../../../lib/http";
import { patientById } from "../../../../../lib/queries";

export const dynamic = "force-dynamic";

/**
 * Patient SMS is not implemented.
 * lib/pipeline/sms-outbox.ts can only print a redacted console preview for aggregate
 * Eliquis prescriber impacts. It stores no phone number and throws if asked to deliver.
 * Patients are an id and a name, so there is no number to send to.
 * This route checks the patient, then returns that limitation. It does not preview,
 * enqueue, or mark anything sent.
 */
const SMS_UNAVAILABLE =
  "Live SMS delivery is not implemented. Patient records have no phone number. The existing SMS outbox only prints a redacted console preview for aggregate prescriber impacts and cannot deliver a text.";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const patient = await patientById(id);
    if (!patient) throw new ApiError(404, `Patient ${id} not found`);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError(400, "Body must be a JSON object");
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message !== "string" || !message.trim()) throw new ApiError(400, "message is required");

    throw new ApiError(501, SMS_UNAVAILABLE);
  } catch (err) {
    return errorResponse(err);
  }
}
