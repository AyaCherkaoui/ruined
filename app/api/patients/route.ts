import { errorResponse } from "../../../lib/http";
import { listPatients } from "../../../lib/patients";

export const dynamic = "force-dynamic";

// GET /api/patients -> Patient[]
export async function GET() {
  try {
    return Response.json(await listPatients());
  } catch (err) {
    return errorResponse(err);
  }
}
