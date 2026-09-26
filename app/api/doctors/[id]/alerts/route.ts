import { alertsForDoctor } from "../../../../../lib/queries";
import { errorResponse } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return Response.json(await alertsForDoctor(id));
  } catch (err) {
    return errorResponse(err);
  }
}
