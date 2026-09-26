import { ApiError, errorResponse } from "../../../../lib/http";
import { searchPlanDrugs } from "../../../../lib/drugSearch";
import { getPatient } from "../../../../lib/patients";

export const dynamic = "force-dynamic";

// GET /api/drugs/search?patientId=pt-007&q=myr -> DrugOption[]  (max 10, only drugs on that
// patient's plan formulary, matched on name)
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const patientId = url.searchParams.get("patientId")?.trim();
    const q = url.searchParams.get("q")?.trim();
    if (!patientId) throw new ApiError(400, "Provide patientId");
    if (!q) throw new ApiError(400, "Provide q");

    const patient = await getPatient(patientId);
    if (!patient) throw new ApiError(404, `Patient ${patientId} not found`);

    return Response.json(await searchPlanDrugs(patient.plan, q));
  } catch (err) {
    return errorResponse(err);
  }
}
