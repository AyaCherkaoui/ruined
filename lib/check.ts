import { findAlternatives } from "./alternatives";
import type { CheckResponse } from "./contract";
import { checkCoverage, loadPlanContext, type PlanKey } from "./coverage";
import { getDb, type Db } from "./db";
import { normalizeDrug } from "./drugs";
import { RxNavClient, RxNavError } from "./rxnav";
import { ApiError } from "./http";
import { getPatient } from "./patients";

// Request handling for POST /api/check: "does this plan cover this drug, and what is cheaper?"
// Deterministic lookups only. Drug-name matching uses RxNav string matching, never an LLM.

/** Body of POST /api/check. Identify the plan (patientId OR contractId+planId[+segmentId]) and the drug (rxcui OR drugName). */
export interface CheckRequest {
  patientId?: string;
  contractId?: string;
  planId?: string;
  segmentId?: string;
  rxcui?: string;
  drugName?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

async function resolvePlan(req: CheckRequest, db: Db): Promise<PlanKey> {
  const patientId = str(req.patientId);
  if (patientId) {
    const patient = await getPatient(patientId, db);
    if (!patient) throw new ApiError(404, `Patient ${patientId} not found`);
    const { contractId, planId, segmentId } = patient.plan;
    return { contractId, planId, segmentId };
  }
  const contractId = str(req.contractId);
  const planId = str(req.planId);
  if (!contractId || !planId) {
    throw new ApiError(400, "Provide patientId, or contractId and planId (segmentId defaults to 000)");
  }
  return { contractId, planId, segmentId: str(req.segmentId) ?? "000" };
}

/** Formulary drugs on this plan that a bare ingredient ("apixaban") or brand ("Ozempic") name could mean. */
async function choicesOnPlan(db: Db, plan: PlanKey, drug: { tty: string | null; name: string; ingredientRxcui: string | null }) {
  const ctx = await loadPlanContext(db, plan);
  const rows = await db.query<{ rxcui: string; name: string }>(
    `SELECT DISTINCT d.rxcui, d.name FROM formulary f JOIN drugs d ON d.rxcui = f.rxcui
      WHERE f.data_version = $1 AND f.formulary_id = $2
        AND (($3 <> '' AND d.ingredient_rxcui = $3) OR ($4 <> '' AND d.name LIKE $4))
      ORDER BY d.name LIMIT 15`,
    [ctx.dataVersion, ctx.formularyId, drug.ingredientRxcui ?? "", drug.tty === "BN" ? `%[${drug.name}]%` : ""],
  );
  return rows.map((r) => ({ rxcui: r.rxcui, drugName: r.name }));
}

export async function runCheck(req: CheckRequest, db?: Db, rx?: RxNavClient): Promise<CheckResponse> {
  const conn = db ?? (await getDb());
  const plan = await resolvePlan(req, conn);

  let rxcui = str(req.rxcui);
  if (rxcui !== undefined && !/^\d+$/.test(rxcui)) throw new ApiError(400, "rxcui must be numeric");
  if (!rxcui) {
    const name = str(req.drugName);
    if (!name) throw new ApiError(400, "Provide rxcui or drugName");
    const drug = await normalizeDrug(conn, name, rx).catch((err) => {
      if (err instanceof RxNavError) throw new ApiError(502, "Drug lookup service (RxNav) is unavailable; try again or send an rxcui");
      throw err;
    });
    if (!drug) throw new ApiError(404, `No drug found matching "${name}"`);
    rxcui = drug.rxcui;

    // A bare ingredient / brand name has no strength, so it never appears on a formulary itself.
    if (drug.tty === "IN" || drug.tty === "MIN" || drug.tty === "PIN" || drug.tty === "BN") {
      const choices = await choicesOnPlan(conn, plan, drug);
      throw new ApiError(422, `"${name}" matches ${drug.name} (${drug.tty}) without a strength; pick a specific product`, {
        matched: { rxcui: drug.rxcui, drugName: drug.name },
        choices,
      });
    }
  }

  const [coverage, alternatives] = await Promise.all([
    checkCoverage(plan.contractId, plan.planId, plan.segmentId, rxcui, { db: conn }),
    findAlternatives(plan, rxcui, { db: conn }),
  ]);
  return { coverage, alternatives };
}
