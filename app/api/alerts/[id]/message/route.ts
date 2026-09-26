import { ApiError, errorResponse } from "../../../../../lib/http";
import { buildPatientMessage } from "../../../../../lib/message";
import { getPatientAlert } from "../../../../../lib/patientAlerts";
import { getAlertStatus, setAlertStatus } from "../../../../../lib/alertStatus";

export const dynamic = "force-dynamic";

// POST /api/alerts/:id/message -> PatientMessage (Grok translation + ElevenLabs speech; falls
// back to English text if the translation changes a number). Sets status "patient_notified".
// 404 if the id doesn't name a real alert; 503 with a clear message if XAI_API_KEY /
// ELEVENLABS_API_KEY isn't configured yet (never a crash).
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const alert = await getPatientAlert(id);
    if (!alert) throw new ApiError(404, `Alert ${id} not found`);

    const message = await buildPatientMessage(alert);

    const current = await getAlertStatus(id);
    await setAlertStatus(id, "patient_notified", current.switchedTo);

    return Response.json(message);
  } catch (err) {
    return errorResponse(err);
  }
}
