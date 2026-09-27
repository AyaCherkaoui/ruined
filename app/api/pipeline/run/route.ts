import { errorResponse } from "../../../../lib/http";
import { requireUser } from "../../../../lib/auth";
import { runAppPipeline } from "../../../../lib/pipeline/app-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed, already staged demo inputs only; no downloads, arbitrary paths, or SMS.
export async function POST() {
  try { await requireUser(); return Response.json(await runAppPipeline()); }
  catch (error) { return errorResponse(error); }
}
