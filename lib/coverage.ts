import type { CoverageResult, CoverageStatus } from "./contract";
import { getDb, type Db } from "./db";
import { getDrug } from "./drugs";

// Deterministic coverage + cost logic. Everything here comes from the CMS Part D public use
// file loaded into our database (formulary, beneficiary_cost, pricing) -- never from an LLM.
//
// Every dollar figure is an ESTIMATE (CoverageResult.isEstimate is always true):
//   * cost sharing = plan's initial-coverage cost share for the drug's tier (deductibles,
//     coverage phases, manufacturer discounts and the out-of-pocket cap are ignored)
//   * total drug cost = CMS "unit cost" x an assumed 30-day quantity (see monthlyQuantity)

export const DEFAULT_DATA_VERSION = "v1";

export interface PlanKey {
  contractId: string;
  planId: string;
  segmentId: string;
}

export interface CheckOptions {
  db?: Db;
  /** Which loaded data version to read (default 'v1'). */
  dataVersion?: string;
  /** Which retail cost-share column to use. Default 'standard': always offered, and the conservative choice. */
  pharmacy?: "standard" | "preferred";
  /** Override the assumed units dispensed per 30 days (e.g. from a known dose). */
  quantityPer30Days?: number;
}

export class PlanNotFoundError extends Error {
  constructor(key: PlanKey, dataVersion: string) {
    super(`Plan ${key.contractId}-${key.planId}-${key.segmentId} not found in data version ${dataVersion}`);
    this.name = "PlanNotFoundError";
  }
}

// ---------------------------------------------------------------------------------------
// Pure helpers (unit tested without a database)
// ---------------------------------------------------------------------------------------

/** COST_TYPE 0 = not offered, 1 = copay in dollars, 2 = coinsurance as a fraction (0.25 = 25%). */
export interface CostShare {
  type: 1 | 2;
  amount: number;
  min: number;
  max: number;
}

export interface CostRow {
  tier: number;
  coverage_level: number;
  cost_type_pref: number | null;
  cost_amt_pref: number | null;
  cost_min_amt_pref: number | null;
  cost_max_amt_pref: number | null;
  cost_type_nonpref: number | null;
  cost_amt_nonpref: number | null;
  cost_min_amt_nonpref: number | null;
  cost_max_amt_nonpref: number | null;
  /** The plan flags this tier as a specialty tier (rare / very high-cost drugs). */
  tier_specialty: boolean | null;
}

/**
 * Pick the retail cost share for the requested pharmacy type, falling back to the other one if
 * the plan does not offer that type for this tier. Null if the tier has no usable cost share.
 */
export function pickCostShare(row: CostRow, pharmacy: "standard" | "preferred" = "standard"): CostShare | null {
  const standard = { type: row.cost_type_nonpref, amt: row.cost_amt_nonpref, min: row.cost_min_amt_nonpref, max: row.cost_max_amt_nonpref };
  const preferred = { type: row.cost_type_pref, amt: row.cost_amt_pref, min: row.cost_min_amt_pref, max: row.cost_max_amt_pref };
  for (const c of pharmacy === "standard" ? [standard, preferred] : [preferred, standard]) {
    if ((c.type === 1 || c.type === 2) && c.amt !== null) {
      return { type: c.type, amount: c.amt, min: c.min ?? 0, max: c.max ?? 0 };
    }
  }
  return null;
}

/**
 * What the patient pays for one fill given the plan's cost share and the total drug cost.
 *  copay:        the flat dollar amount, but never more than the drug actually costs
 *  coinsurance:  fraction x drug cost, clamped to the plan's min / max dollar amounts when set
 */
export function patientCost(share: CostShare, totalDrugCost: number): number {
  if (share.type === 1) return Math.min(share.amount, totalDrugCost);
  let pays = share.amount * totalDrugCost;
  if (share.min > 0) pays = Math.max(pays, share.min);
  if (share.max > 0) pays = Math.min(pays, share.max);
  return pays;
}

/**
 * Units assumed dispensed per 30 days. The CMS file has no dose, and a plan's quantity limit (QL) is a
 * maximum, not a dose -- so using each plan's own QL would price the same drug differently by plan
 * (Eliquis: 30, 60 or 74 tablets). Instead the quantity is a property of the DRUG:
 *  - typical = see typicalQuantity: derived from the QLs plans set on this rxcui (Eliquis 5 mg -> 60, twice daily)
 *  - no plan sets a QL: oral products = 30 units (one a day); injectables, inhalers, topicals = 1 unit
 *  - if THIS plan's QL is lower than typical, the patient can only fill up to it, so cap at the plan's QL
 */
export function monthlyQuantity(
  typicalFromQls: number | null,
  planQl: number | null,
  doseFormGroup: string | null,
): number {
  const base = typicalFromQls ?? (doseFormGroup === null || doseFormGroup === "Oral Product" ? 30 : 1);
  return planQl !== null ? Math.min(base, planQl) : base;
}

/**
 * Typical 30-day quantity from the QL-implied quantities of every formulary that sets a QL on the drug.
 * A QL is a ceiling, so the median runs high (Eliquis: 21 formularies say 74 = the first-30-days DVT/PE
 * loading quantity, 6 say 60 = the steady twice-daily dose). We take the SMALLEST quantity that at least
 * 20% of those formularies agree on: it finds the standard dose, and one odd plan cannot drag it around.
 */
export function typicalQuantity(qlQuantities: number[]): number | null {
  if (qlQuantities.length === 0) return null;
  const counts = new Map<number, number>();
  for (const q of qlQuantities) {
    const key = Math.round(q * 100) / 100;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const needed = Math.ceil(0.2 * qlQuantities.length);
  return [...counts.entries()].filter(([, n]) => n >= needed).map(([q]) => q).sort((a, b) => a - b)[0];
}

/** QL "amount per days" scaled to 30 days; null if the row has no usable limit. */
export function qlPer30Days(amount: number | null, days: number | null): number | null {
  return amount !== null && days !== null && amount > 0 && days > 0 ? (amount * 30) / days : null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function coverageStatus(f: { priorAuth: boolean; stepTherapy: boolean; quantityLimit: boolean }): CoverageStatus {
  return f.priorAuth || f.stepTherapy || f.quantityLimit ? "restricted" : "covered";
}

// ---------------------------------------------------------------------------------------
// Database-backed
// ---------------------------------------------------------------------------------------

export interface PlanContext {
  key: PlanKey;
  planName: string;
  formularyId: string;
  dataVersion: string;
  /** Best cost row per tier (initial coverage level 1, else pre-deductible level 0), 30-day supply. */
  costByTier: Map<number, CostRow>;
}

export async function loadPlanContext(db: Db, key: PlanKey, dataVersion = DEFAULT_DATA_VERSION): Promise<PlanContext> {
  const plan = await db.query<{ plan_name: string; formulary_id: string }>(
    `SELECT plan_name, formulary_id FROM plans
      WHERE data_version = $1 AND contract_id = $2 AND plan_id = $3 AND segment_id = $4`,
    [dataVersion, key.contractId, key.planId, key.segmentId],
  );
  if (plan.length === 0) throw new PlanNotFoundError(key, dataVersion);

  // days_supply = 1 means a 30-day supply in the CMS beneficiary cost file
  const costs = await db.query<CostRow>(
    `SELECT tier, coverage_level, cost_type_pref, cost_amt_pref, cost_min_amt_pref, cost_max_amt_pref,
            cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref, tier_specialty
       FROM beneficiary_cost
      WHERE data_version = $1 AND contract_id = $2 AND plan_id = $3 AND segment_id = $4
        AND days_supply = 1 AND coverage_level IN (0, 1)
      ORDER BY coverage_level`,
    [dataVersion, key.contractId, key.planId, key.segmentId],
  );
  const costByTier = new Map<number, CostRow>();
  for (const row of costs) costByTier.set(row.tier, row); // level 1 rows come last and win over level 0

  return { key, planName: plan[0].plan_name, formularyId: plan[0].formulary_id, dataVersion, costByTier };
}

/** Is this tier one the plan designates as a specialty tier? */
export function isSpecialtyTier(ctx: PlanContext, tier: number | null): boolean {
  return tier !== null && ctx.costByTier.get(tier)?.tier_specialty === true;
}

interface FormularyRow {
  rxcui: string;
  ndc: string;
  tier: number | null;
  quantity_limit: boolean;
  quantity_limit_amount: number | null;
  quantity_limit_days: number | null;
  prior_authorization: boolean;
  step_therapy: boolean;
}

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");

/**
 * Coverage + estimated 30-day cost for many drugs on one plan in a fixed number of queries.
 * Result has an entry for every requested rxcui (not_covered if the plan's formulary lacks it).
 */
export async function coverageForRxcuis(
  db: Db,
  ctx: PlanContext,
  rxcuis: string[],
  opts: CheckOptions = {},
): Promise<Map<string, CoverageResult>> {
  const ids = [...new Set(rxcuis)];
  const out = new Map<string, CoverageResult>();
  if (ids.length === 0) return out;

  const drugs = await db.query<{ rxcui: string; name: string; dose_form_group: string | null }>(
    `SELECT rxcui, name, dose_form_group FROM drugs WHERE rxcui IN (${placeholders(ids.length)})`,
    ids,
  );
  const drugById = new Map(drugs.map((d) => [d.rxcui, d]));

  // Typical 30-day quantity per drug: from every formulary (any plan) that sets a QL on it
  const qls = await db.query<{ rxcui: string; amount: number; days: number }>(
    `SELECT rxcui, quantity_limit_amount AS amount, quantity_limit_days AS days FROM formulary
      WHERE data_version = $1 AND quantity_limit AND quantity_limit_amount > 0 AND quantity_limit_days > 0
        AND rxcui IN (${placeholders(ids.length, 2)})`,
    [ctx.dataVersion, ...ids],
  );
  const qlQuantities = new Map<string, number[]>();
  for (const q of qls) qlQuantities.set(q.rxcui, [...(qlQuantities.get(q.rxcui) ?? []), (q.amount * 30) / q.days]);

  const formulary = await db.query<FormularyRow>(
    `SELECT rxcui, ndc, tier, quantity_limit, quantity_limit_amount, quantity_limit_days,
            prior_authorization, step_therapy
       FROM formulary
      WHERE data_version = $1 AND formulary_id = $2 AND rxcui IN (${placeholders(ids.length, 3)})`,
    [ctx.dataVersion, ctx.formularyId, ...ids],
  );
  const rowsByRxcui = new Map<string, FormularyRow[]>();
  for (const r of formulary) rowsByRxcui.set(r.rxcui, [...(rowsByRxcui.get(r.rxcui) ?? []), r]);

  // 30-day unit costs for every NDC involved
  const ndcs = [...new Set(formulary.map((r) => r.ndc))];
  const unitCost = new Map<string, number>();
  if (ndcs.length > 0) {
    const priced = await db.query<{ ndc: string; unit_cost: number }>(
      `SELECT ndc, unit_cost FROM pricing
        WHERE data_version = $1 AND contract_id = $2 AND plan_id = $3 AND segment_id = $4
          AND days_supply = 30 AND ndc IN (${placeholders(ndcs.length, 5)})`,
      [ctx.dataVersion, ctx.key.contractId, ctx.key.planId, ctx.key.segmentId, ...ndcs],
    );
    for (const p of priced) unitCost.set(p.ndc, p.unit_cost);
  }

  for (const rxcui of ids) {
    const drugName = drugById.get(rxcui)?.name ?? `RXCUI ${rxcui}`;
    const rows = rowsByRxcui.get(rxcui);
    if (!rows || rows.length === 0) {
      out.set(rxcui, {
        rxcui,
        drugName,
        status: "not_covered",
        tier: null,
        priorAuth: false,
        stepTherapy: false,
        quantityLimit: false,
        estMonthlyCost: null,
        isEstimate: true,
      });
      continue;
    }

    // The CMS file has one NDC per (formulary, rxcui); if that ever changes, combine conservatively.
    const tiers = rows.map((r) => r.tier).filter((t): t is number => t !== null);
    const tier = tiers.length > 0 ? Math.min(...tiers) : null;
    const flags = {
      priorAuth: rows.some((r) => r.prior_authorization),
      stepTherapy: rows.some((r) => r.step_therapy),
      quantityLimit: rows.some((r) => r.quantity_limit),
    };

    let estMonthlyCost: number | null = null;
    const prices = rows.map((r) => unitCost.get(r.ndc)).filter((p): p is number => p !== undefined);
    const costRow = tier === null ? undefined : ctx.costByTier.get(tier);
    const share = costRow ? pickCostShare(costRow, opts.pharmacy) : null;
    if (prices.length > 0 && share) {
      const qlRow = rows.find((r) => r.quantity_limit);
      const typical = qlQuantities.get(rxcui);
      const quantity =
        opts.quantityPer30Days ??
        monthlyQuantity(
          typical ? typicalQuantity(typical) : null,
          qlRow ? qlPer30Days(qlRow.quantity_limit_amount, qlRow.quantity_limit_days) : null,
          drugById.get(rxcui)?.dose_form_group ?? null,
        );
      estMonthlyCost = round2(patientCost(share, median(prices) * quantity));
    }

    out.set(rxcui, {
      rxcui,
      drugName,
      status: coverageStatus(flags),
      tier,
      ...flags,
      estMonthlyCost,
      isEstimate: true,
    });
  }
  return out;
}

/**
 * Is `rxcui` covered by this plan, at what tier, with which restrictions, and what is the
 * estimated 30-day out-of-pocket cost? Throws PlanNotFoundError for an unknown plan.
 */
export async function checkCoverage(
  contractId: string,
  planId: string,
  segmentId: string,
  rxcui: string,
  opts: CheckOptions = {},
): Promise<CoverageResult> {
  const db = opts.db ?? (await getDb());
  const ctx = await loadPlanContext(db, { contractId, planId, segmentId }, opts.dataVersion);
  // If we have never seen this rxcui, look up its name (one RxNav call, then cached)
  await getDrug(db, rxcui).catch(() => null);
  const result = (await coverageForRxcuis(db, ctx, [rxcui], opts)).get(rxcui);
  if (!result) throw new Error("unreachable: coverageForRxcuis returns every requested rxcui");
  return result;
}
