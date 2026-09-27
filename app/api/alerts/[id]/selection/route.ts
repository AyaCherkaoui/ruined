import { ApiError, errorResponse } from "../../../../../lib/http";
import { requireUser } from "../../../../../lib/auth";
import { selectAlternative } from "../../../../../lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    let input: unknown;
    try { input = await request.json(); } catch { throw new ApiError(400, "Expected a JSON request."); }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !("rxcui" in input) || typeof input.rxcui !== "string" || !/^\d{1,12}$/.test(input.rxcui)) {
      throw new ApiError(400, "Provide a valid alternative RXCUI.");
    }
    const { id } = await ctx.params;
    return Response.json(await selectAlternative(id, input.rxcui));
  } catch (error) { return errorResponse(error); }
}
