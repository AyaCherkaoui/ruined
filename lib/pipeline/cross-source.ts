import type { CoverageObservation, CoveragePlanKey } from "./aggregate-contract";
import { planKey, stableId, validateObservation } from "./aggregate-store";

export interface AlignedSource {
  effectivePeriod: { start: string; end: string } | null;
  observations: CoverageObservation[];
}
export interface PlanMapping { cms: CoveragePlanKey; humana: CoveragePlanKey }
type Field = "covered" | "tier" | "priorAuthorization" | "stepTherapy" | "quantityLimit";
export interface Discrepancy {
  id: string; rxcui: string; cmsPlan: CoveragePlanKey; humanaPlan: CoveragePlanKey;
  field: Field; severity: "high" | "medium"; cmsValue: unknown; humanaValue: unknown;
  effectivePeriod: NonNullable<AlignedSource["effectivePeriod"]>;
  lineage: { source: CoverageObservation["source"]; observationId: string; runId: string; releaseId: string; rawArtifactHash: string; provenance: CoverageObservation["provenance"] }[];
}

/** Reporting only. Explicit period assertions are required; capture dates do not establish alignment. */
export function crossCheck(cms: AlignedSource, humana: AlignedSource, mappings: PlanMapping[]) {
  const discrepancies: Discrepancy[] = [];
  const checks: { cmsObservationId: string; status: "agreement" | "disagreement" | "missing_mapping" | "missing_observation" | "timing_mismatch" | "unknown_values" }[] = [];
  for (const [input, source] of [[cms, "cms_monthly"], [humana, "humana_fhir"]] as const) {
    const keys = new Set<string>();
    for (const observation of input.observations) {
      validateObservation(observation);
      if (!observation.id || observation.source !== source) throw new Error("Cross-check source/identity mismatch");
      const key = stableId(observation.plan, observation.rxcui, observation.ndc);
      if (keys.has(key)) throw new Error("Ambiguous cross-check observation");
      keys.add(key);
    }
  }
  for (const side of ["cms", "humana"] as const) {
    if (new Set(mappings.map((m) => planKey(m[side]))).size !== mappings.length) throw new Error("Plan mappings must be one-to-one");
  }
  const period = (value: AlignedSource["effectivePeriod"]) => value && Number.isFinite(Date.parse(value.start)) && Date.parse(value.end) > Date.parse(value.start) ? [Date.parse(value.start), Date.parse(value.end)] : null;
  const aPeriod = period(cms.effectivePeriod), bPeriod = period(humana.effectivePeriod);
  const aligned = aPeriod && bPeriod && JSON.stringify(aPeriod) === JSON.stringify(bPeriod);
  for (const a of [...cms.observations].sort((x, y) => x.id.localeCompare(y.id))) {
    const mapping = mappings.find((m) => planKey(m.cms) === planKey(a.plan) && m.cms.sourcePlanId === a.plan.sourcePlanId);
    const record = (status: (typeof checks)[number]["status"]) => checks.push({ cmsObservationId: a.id, status });
    if (!mapping) { record("missing_mapping"); continue; }
    const b = humana.observations.find((o) => planKey(o.plan) === planKey(mapping.humana) && o.plan.sourcePlanId === mapping.humana.sourcePlanId && o.rxcui === a.rxcui && o.ndc === a.ndc);
    if (!b) { record("missing_observation"); continue; }
    if (!aligned || [a, b].some((o) => o.effectiveAt && (Date.parse(o.effectiveAt) < aPeriod![0] || Date.parse(o.effectiveAt) >= aPeriod![1]))) { record("timing_mismatch"); continue; }
    let unknown = false;
    const before = discrepancies.length;
    const compare = (field: Field, x: unknown, y: unknown) => {
      if (x === null || y === null) { unknown = true; return; }
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      discrepancies.push({ id: stableId(a.id, b.id, field, aPeriod, x, y), rxcui: a.rxcui, cmsPlan: a.plan, humanaPlan: b.plan, field,
        severity: field === "covered" ? "high" : "medium", cmsValue: x, humanaValue: y, effectivePeriod: cms.effectivePeriod!,
        lineage: [a, b].map((o) => ({ source: o.source, observationId: o.id, runId: o.sourceRunId, releaseId: o.sourceReleaseId, rawArtifactHash: o.rawArtifactHash, provenance: o.provenance })) });
    };
    compare("covered", a.covered, b.covered);
    if (a.covered && b.covered) {
      for (const field of ["tier", "priorAuthorization", "stepTherapy"] as const) compare(field, a[field], b[field]);
      compare("quantityLimit", a.quantityLimit.applies, b.quantityLimit.applies);
      if (a.quantityLimit.applies && b.quantityLimit.applies) {
        const rate = (o: CoverageObservation) => o.quantityLimit.amount !== null && o.quantityLimit.days !== null ? o.quantityLimit.amount / o.quantityLimit.days : null;
        compare("quantityLimit", rate(a), rate(b));
      }
    }
    record(discrepancies.length > before ? "disagreement" : unknown ? "unknown_values" : "agreement");
  }
  return { primarySource: "cms_monthly", checks, discrepancies };
}
