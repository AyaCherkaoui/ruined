import { ApiError, errorResponse } from "../../../../../lib/http";
import { getPatientAlert } from "../../../../../lib/patientAlerts";
import { setAlertStatus } from "../../../../../lib/alertStatus";

export const dynamic = "force-dynamic";

// POST /api/alerts/:id/dismiss -> PatientAlert with status "dismissed"
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const alert = await getPatientAlert(id);
    if (!alert) throw new ApiError(404, `Alert ${id} not found`);

    await setAlertStatus(id, "dismissed");
    return Response.json({ ...alert, status: "dismissed" });
  } catch (err) {
    return errorResponse(err);
  }
}
