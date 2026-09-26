import { errorResponse } from "../../../../lib/http";
import { searchPatients } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json(await searchPatients(q));
  } catch (err) {
    return errorResponse(err);
  }
}
