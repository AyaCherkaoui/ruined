import { ApiError, errorResponse } from "../../../../lib/http";
import { searchPatientDrugs } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const patientId = url.searchParams.get("patientId") ?? "";
    if (!patientId.trim()) throw new ApiError(400, "patientId is required");
    const q = url.searchParams.get("q") ?? "";
    return Response.json(await searchPatientDrugs(patientId, q));
  } catch (err) {
    return errorResponse(err);
  }
}
