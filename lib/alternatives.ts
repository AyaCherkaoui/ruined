import type { Alternative, CoverageResult } from "./contract";
import { coverageForRxcuis, isSpecialtyTier, loadPlanContext, round2, type CheckOptions, type PlanKey } from "./coverage";
import { getDb } from "./db";
import { getDrug } from "./drugs";

// findAlternatives: cheaper drugs in the same therapeutic class that the same plan covers.
// Pure data + deterministic rules (ATC class from RxClass, formulary + cost from CMS data).

export const MAX_ALTERNATIVES = 3;

export interface AlternativeOptions extends CheckOptions {
  /** Return at most this many (default 3). */
  limit?: number;
  /** Also return options that cost the same or more than the current drug. Default false ("cheaper" only). */
  includeCostlier?: boolean;
}

// Class membership is not the same as substitutability. Scanning real plans showed a bare "same ATC class"
// rule pairs drugs no clinician would swap: an AML drug with celecoxib, hepatitis C therapy with ribavirin,
// morphine with oxycodone, clozapine with olanzapine, dronedarone with amiodarone, a maintenance LABA inhaler
// with a rescue SABA, oral vancomycin with nystatin (ATC also has obscure secondary codes that cause odd matches).
// So class-level alternatives are only offered inside this curated list of ATC level-4 classes where
// in-class substitution is routine formulary practice. It is deliberately conservative: opioids, stimulants,
// benzodiazepines, antiepileptics, antipsychotics, antiarrhythmics, insulins, inhalers, oncology, immunology
// and anti-infectives are all left out. A clinician / pharmacist should review and extend this list.
export const INTERCHANGEABLE_CLASSES: ReadonlySet<string> = new Set([
  // cardiovascular
  "C10AA", // HMG CoA reductase inhibitors (statins)
  "C09AA", // ACE inhibitors, plain
  "C09CA", // angiotensin II receptor blockers, plain
  "C08CA", // dihydropyridine calcium channel blockers
  "C07AB", // beta blockers, selective
  "C03AA", // thiazide diuretics, plain
  "C03CA", // loop diuretics
  "B01AF", // direct factor Xa inhibitors (apixaban, rivaroxaban, edoxaban)
  // diabetes
  "A10BJ", // GLP-1 analogues
  "A10BK", // SGLT2 inhibitors
  "A10BH", // DPP-4 inhibitors
  "A10BB", // sulfonylureas
  // gastrointestinal
  "A02BC", // proton pump inhibitors
  "A02BA", // H2 receptor antagonists
  // nervous system
  "N06AB", // SSRIs
  "N06DA", // cholinesterase inhibitors
  "N02CC", // triptans
  "N02CD", // CGRP antagonists
  // genito-urinary
  "G04CA", // alpha-adrenoreceptor antagonists (tamsulosin...)
  "G04CB", // 5-alpha-reductase inhibitors
  "G04BD", // urinary antispasmodics
  // musculoskeletal / other
  "M05BA", // bisphosphonates
  "M04AA", // xanthine oxidase inhibitors (allopurinol, febuxostat)
  "S01EE", // prostaglandin analogues for glaucoma
  "R01AD", // nasal corticosteroids
  "R03DC", // leukotriene receptor antagonists
]);

export function classAllowsAlternatives(classId: string): boolean {
  return INTERCHANGEABLE_CLASSES.has(classId);
}

// Specialty-tier drugs (the plan's own TIER_SPECIALTY flag: rare, very high-cost drugs) never get class-level
// alternatives, as source or alternative: a scan paired vigabatrin with valproic acid and fidaxomicin (C. diff)
// with nystatin. A brand's exact generic equivalent is exempt from both guards -- it is the same drug.

const hasRestriction = (c: CoverageResult) => c.priorAuth || c.stepTherapy || c.quantityLimit;

/**
 * Ordering: drugs with no restrictions (no PA / step therapy / quantity limit) first, then lowest
 * estimated monthly cost, then lowest tier, then name and rxcui so the order is always deterministic.
 */
export function compareAlternatives(a: CoverageResult, b: CoverageResult): number {
  return (
    Number(hasRestriction(a)) - Number(hasRestriction(b)) ||
    (a.estMonthlyCost ?? Infinity) - (b.estMonthlyCost ?? Infinity) ||
    (a.tier ?? Infinity) - (b.tier ?? Infinity) ||
    a.drugName.localeCompare(b.drugName) ||
    a.rxcui.localeCompare(b.rxcui)
  );
}

/**
 * Up to 3 alternatives for `rxcui` on this plan.
 *
 * Two kinds of candidate, both must be a single clinical drug (SCD generic / SBD brand: never a starter
 * pack or kit) that is on the plan's formulary with a price, so it can be ranked:
 *  1. the generic equivalent of a brand-name source (RxNorm tradename_of link) -- exactly the switch a doctor
 *     wants to see (Lipitor -> atorvastatin). Same drug, so no class or tier guardrails apply.
 *  2. other ingredients in the same ATC level-4 class and route family (oral vs injectable...), only for
 *     classes in INTERCHANGEABLE_CLASSES and never on a specialty tier (see the guardrails above).
 * and it must cost the patient less than the current drug (unless includeCostlier); if the current drug is
 * not covered at all its cost is unknown, so every covered candidate qualifies with monthlySavings 0.
 *
 * One entry per ingredient, so the list is not three strengths of one drug. We cannot know which strength
 * is dose-equivalent (that is the prescriber's call), so each alternative ingredient is represented by its
 * WORST-CASE covered product (most restricted, then most expensive). Any saving shown therefore holds
 * whichever strength is chosen, instead of being inflated by picking the cheapest strength.
 * These are class-level suggestions for the prescriber to review, not clinically validated interchanges.
 */
export async function findAlternatives(
  plan: PlanKey,
  rxcui: string,
  opts: AlternativeOptions = {},
): Promise<Alternative[]> {
  const db = opts.db ?? (await getDb());
  const limit = opts.limit ?? MAX_ALTERNATIVES;
  const ctx = await loadPlanContext(db, plan, opts.dataVersion);

  const source = await getDrug(db, rxcui).catch(() => null);
  if (!source) return [];

  // Class-level candidates (guarded)
  let classRows: { rxcui: string; ingredient_rxcui: string | null }[] = [];
  if (source.classId && classAllowsAlternatives(source.classId)) {
    const params: (string | number)[] = [ctx.dataVersion, ctx.formularyId, source.classId, rxcui];
    let sql = `SELECT DISTINCT d.rxcui, d.ingredient_rxcui
                 FROM formulary f JOIN drugs d ON d.rxcui = f.rxcui
                WHERE f.data_version = $1 AND f.formulary_id = $2 AND d.class_id = $3 AND d.rxcui <> $4
                  AND d.tty IN ('SCD', 'SBD')`;
    if (source.doseFormGroup) {
      params.push(source.doseFormGroup);
      sql += ` AND d.dose_form_group = $${params.length}`;
    }
    classRows = (await db.query<{ rxcui: string; ingredient_rxcui: string | null }>(sql, params)).filter(
      (r) => r.ingredient_rxcui === null || r.ingredient_rxcui !== source.ingredientRxcui,
    );
  }

  const genericRxcui = source.genericRxcui;
  const ingredientOf = new Map(classRows.map((c) => [c.rxcui, c.ingredient_rxcui ?? `rxcui:${c.rxcui}`]));
  if (genericRxcui) ingredientOf.set(genericRxcui, `generic:${genericRxcui}`);
  if (ingredientOf.size === 0) return [];

  const results = await coverageForRxcuis(db, ctx, [rxcui, ...ingredientOf.keys()], opts);
  const sourceCoverage = results.get(rxcui);
  const sourceCost = sourceCoverage?.estMonthlyCost ?? null;
  const sourceIsSpecialty = isSpecialtyTier(ctx, sourceCoverage?.tier ?? null);

  // Covered + priced candidates, grouped by ingredient; keep each group's worst-case product
  const worstByIngredient = new Map<string, CoverageResult>();
  for (const [candidate, key] of ingredientOf) {
    const c = results.get(candidate)!;
    if (c.status === "not_covered" || c.estMonthlyCost === null) continue;
    if (candidate !== genericRxcui && (sourceIsSpecialty || isSpecialtyTier(ctx, c.tier))) continue;
    const worst = worstByIngredient.get(key);
    if (!worst || compareAlternatives(c, worst) > 0) worstByIngredient.set(key, c);
  }

  return [...worstByIngredient.values()]
    .filter((c) => opts.includeCostlier || sourceCost === null || c.estMonthlyCost! < sourceCost)
    .sort(compareAlternatives)
    .slice(0, limit)
    .map((c) => ({ ...c, monthlySavings: sourceCost === null ? 0 : round2(sourceCost - c.estMonthlyCost!) }));
}
