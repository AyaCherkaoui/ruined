import { ApiError, errorResponse } from "../../../../lib/http";
import { searchPatients } from "../../../../lib/patients";

export const dynamic = "force-dynamic";

// GET /api/patients/search?q=eve -> Patient[]  (case-insensitive name match, max 8)
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams.get("q")?.trim();
    if (!q) throw new ApiError(400, "Provide q");
    return Response.json(await searchPatients(q));
  } catch (err) {
    return errorResponse(err);
  }
}
