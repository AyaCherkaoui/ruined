import { errorResponse } from "../../../../../lib/http";
import { dismissAlert } from "../../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return Response.json(await dismissAlert(id));
  } catch (err) {
    return errorResponse(err);
  }
}
