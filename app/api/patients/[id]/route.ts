import { errorResponse } from "../../../../lib/http";
import { getPatient } from "../../../../lib/patients";

export const dynamic = "force-dynamic";

// GET /api/patients/:id -> Patient (404 if unknown)
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const patient = await getPatient(id);
    if (!patient) return Response.json({ error: `Patient ${id} not found` }, { status: 404 });
    return Response.json(patient);
  } catch (err) {
    return errorResponse(err);
  }
}
