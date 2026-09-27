import { errorResponse } from "../../../lib/http";
import { requireUser } from "../../../lib/auth";
import { listAppChanges } from "../../../lib/pipeline/app-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireUser(); return Response.json(await listAppChanges()); }
  catch (error) { return errorResponse(error); }
}
