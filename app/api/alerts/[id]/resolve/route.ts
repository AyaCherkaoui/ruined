import { resolveAlert } from "../../../../../lib/coverageAlerts";
import { errorResponse } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return Response.json(await resolveAlert(id));
  } catch (err) {
    return errorResponse(err);
  }
}
