import { buildDigest } from "../../../../lib/digest";
import { sendDigestEmail } from "../../../../lib/digestEmail";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

// POST /api/digest/email -> { sent: true, id } (Resend; from onboarding@resend.dev, to DOCTOR_EMAIL).
// 503 with a clear message if DOCTOR_EMAIL / RESEND_API_KEY isn't configured yet.
export async function POST() {
  try {
    const digest = await buildDigest();
    return Response.json(await sendDigestEmail(digest));
  } catch (err) {
    return errorResponse(err);
  }
}
