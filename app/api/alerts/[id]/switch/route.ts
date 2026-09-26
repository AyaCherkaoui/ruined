import { ApiError, errorResponse } from "../../../../../lib/http";
import { getPatientAlert } from "../../../../../lib/patientAlerts";
import { setAlertStatus } from "../../../../../lib/alertStatus";

export const dynamic = "force-dynamic";

// POST /api/alerts/:id/switch  body: { rxcui }  -> PatientAlert with status "switched"
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Body must be JSON");
    }
    const rxcui = typeof (body as { rxcui?: unknown })?.rxcui === "string" ? (body as { rxcui: string }).rxcui.trim() : "";
    if (!rxcui) throw new ApiError(400, "Provide rxcui");

    const alert = await getPatientAlert(id);
    if (!alert) throw new ApiError(404, `Alert ${id} not found`);

    await setAlertStatus(id, "switched", rxcui);
    return Response.json({ ...alert, status: "switched", switchedTo: rxcui });
  } catch (err) {
    return errorResponse(err);
  }
}
