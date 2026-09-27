import type { CoverageResult, InsurerCheck } from "./contract";

export interface InsurerComparison {
  agrees: boolean;
  notes: string[];
}

const flagNames = (f: { priorAuth: boolean; stepTherapy: boolean; quantityLimit: boolean }) =>
  [f.priorAuth && "prior auth", f.stepTherapy && "step therapy", f.quantityLimit && "quantity limit"].filter(
    (name): name is string => Boolean(name),
  );

/** Where the insurer's own API and the CMS file disagree about one drug on one plan. Null when there is nothing to compare. */
export function compareWithCms(cms: CoverageResult, insurer: InsurerCheck): InsurerComparison | null {
  const cmsCovered = cms.status !== "not_covered";
  if (insurer.status === "not_listed") {
    return cmsCovered
      ? { agrees: false, notes: [`CMS lists it as covered, but ${insurer.insurer}'s API has no record for this plan.`] }
      : { agrees: true, notes: [`Both agree: not on this plan's formulary.`] };
  }
  if (insurer.status !== "listed") return null;
  if (!cmsCovered) {
    return { agrees: false, notes: [`CMS says not covered, but ${insurer.insurer}'s API still lists it.`] };
  }
  const notes: string[] = [];
  if (cms.tier !== null && insurer.tier !== null && cms.tier !== insurer.tier) {
    notes.push(`Tier differs: CMS tier ${cms.tier}, ${insurer.insurer} tier ${insurer.tier}.`);
  }
  const cmsFlags = flagNames(cms).join(", ") || "none";
  const insurerFlags = flagNames(insurer).join(", ") || "none";
  if (cmsFlags !== insurerFlags) {
    notes.push(`Restrictions differ: CMS ${cmsFlags}; ${insurer.insurer} ${insurerFlags}.`);
  }
  return notes.length === 0 ? { agrees: true, notes: ["Matches CMS: same tier and restrictions."] } : { agrees: false, notes };
}
