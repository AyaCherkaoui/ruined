import fs from "node:fs/promises";
import type { CoverageAlertChangeType } from "../contract";
import type { CoverageChangeInput } from "../coverageAlerts";
import { ApiError } from "../http";
import type { CoverageChangeFactType, CoverageObservation, EliquisAggregatePayloadV1 } from "./aggregate-contract";
import { observationKey, validateObservation } from "./aggregate-store";
import { classifyObservations } from "./compare-snapshots";

const TYPES: Record<CoverageChangeFactType, CoverageAlertChangeType> = {
  coverage_removed: "dropped", coverage_restored: "restored",
  tier_increased: "tier_increase", tier_decreased: "tier_decrease",
  prior_authorization_added: "prior_auth_added", prior_authorization_removed: "prior_auth_removed",
  step_therapy_added: "step_therapy_added", step_therapy_removed: "step_therapy_removed",
  quantity_limit_added: "quantity_limit_added", quantity_limit_removed: "quantity_limit_removed",
  quantity_limit_tightened: "quantity_limit_tightened", quantity_limit_relaxed: "quantity_limit_relaxed",
};
const INVERSE: Partial<Record<CoverageChangeFactType, CoverageChangeFactType>> = {
  coverage_restored: "coverage_removed", tier_decreased: "tier_increased",
  prior_authorization_removed: "prior_authorization_added", step_therapy_removed: "step_therapy_added",
  quantity_limit_removed: "quantity_limit_added", quantity_limit_relaxed: "quantity_limit_tightened",
};

function rules(o: CoverageObservation): string | null {
  if (!o.covered) return null;
  const flag = (v: boolean | null, yes: string, no: string) => v === null ? `${yes}: unknown` : v ? yes : no;
  const q = o.quantityLimit;
  return [o.tier === null ? "Tier unknown" : `Tier ${o.tier}`,
    flag(o.priorAuthorization, "Prior authorization required", "No prior authorization"),
    flag(o.stepTherapy, "Step therapy required", "No step therapy"),
    flag(q.applies, "Quantity limit", "No quantity limit") +
      (q.applies && q.amount !== null && q.days !== null ? `: ${q.amount} per ${q.days} days` : ""),
  ].join(". ") + ".";
}

/** Translate actual pipeline facts; claims volume is deliberately never a patient count. */
export function aggregateCoverageChanges(payload: EliquisAggregatePayloadV1, npi?: string): CoverageChangeInput[] {
  if (payload?.contractVersion !== "eliquis-aggregate-v1" || !Array.isArray(payload.observations) || !Array.isArray(payload.changes)) {
    throw new Error("Expected an eliquis-aggregate-v1 payload");
  }
  const observations = new Map(payload.observations.map((o) => {
    validateObservation(o);
    if (typeof o.id !== "string" || !o.id) throw new Error("Missing observation identity");
    return [o.id, o];
  }));
  const facts = new Map(payload.changes.map((c) => [c.id, c]));
  if (observations.size !== payload.observations.length || facts.size !== payload.changes.length) throw new Error("Duplicate pipeline identities");
  const alerts = payload.changes.map((c) => {
    const old = observations.get(c.oldObservationId), next = observations.get(c.newObservationId);
    if (typeof c.id !== "string" || !c.id || !old || !next || observationKey(old) !== observationKey(next) ||
        old.source !== next.source || Date.parse(old.capturedAt) >= Date.parse(next.capturedAt) ||
        c.rxcui !== next.rxcui || observationKey({ ...next, plan: c.plan }) !== observationKey(next) ||
        !classifyObservations(old, next).includes(c.changeType) || !Number.isFinite(Date.parse(c.detectedAt)) ||
        c.detectedAt !== next.capturedAt || c.effectiveAt !== next.effectiveAt ||
        c.direction !== (INVERSE[c.changeType] ? "improved" : "worsened")) {
      throw new Error("Invalid pipeline change or missing observations");
    }
    const reversal = c.resolvedByChangeId === null ? null : facts.get(c.resolvedByChangeId);
    if (c.resolvedByChangeId !== null && (!reversal || reversal.resolvesChangeId !== c.id ||
        INVERSE[reversal.changeType] !== c.changeType || reversal.rxcui !== c.rxcui ||
        observationKey({ ...next, plan: reversal.plan }) !== observationKey(next) ||
        Date.parse(reversal.detectedAt) <= Date.parse(c.detectedAt))) {
      throw new Error("Invalid pipeline resolution link");
    }
    if (c.resolvesChangeId !== null && facts.get(c.resolvesChangeId)?.resolvedByChangeId !== c.id) throw new Error("Invalid reciprocal resolution link");
    const planId = `${c.plan.contractId}-${c.plan.planId}-${c.plan.segmentId}`;
    const names: Record<string, string> = { "S5884-135-000": "Humana Basic Rx Plan", "S5884-156-000": "Humana Premier Rx Plan" };
    // Both observations matter: a replay after a simulated baseline is still simulated.
    const simulated = c.provenance === "simulated" || old.provenance === "simulated" || next.provenance === "simulated";
    return {
      id: c.id, insurer: next.source === "cms_monthly" && !names[planId] ? "Plan insurer" : "Humana",
      planId, planName: names[planId] ?? planId,
      drug: `Eliquis (apixaban) ${c.rxcui === "1364447" ? "5" : "2.5"} mg tablet`, rxcui: c.rxcui,
      changeType: TYPES[c.changeType], oldValue: rules(old), newValue: rules(next),
      effectiveDate: next.effectiveAt?.slice(0, 10) ?? null, detectedAt: c.detectedAt,
      source: `${simulated ? "DEMO simulated change; " : ""}${next.source === "cms_monthly" ? "CMS monthly formulary" : "Humana FHIR"}; ${next.provenance}; release ${next.sourceReleaseId}`,
      sourceUrl: null, isDemo: simulated, sourceResolvedAt: reversal?.detectedAt ?? null,
      estimatedPatientRange: null,
    };
  });
  if (npi === undefined) return alerts;
  if (!/^\d{10}$/.test(npi) || !Array.isArray(payload.doctorImpacts)) throw new Error("Invalid doctor targeting configuration or impacts");
  const matched = new Set<string>();
  for (const impact of payload.doctorImpacts) {
    if (impact.npi !== npi) continue;
    const fact = facts.get(impact.changeId);
    if (!fact || fact.rxcui !== impact.rxcui || JSON.stringify([fact.plan.contractId, fact.plan.planId, fact.plan.segmentId]) !==
      JSON.stringify([impact.plan.contractId, impact.plan.planId, impact.plan.segmentId]) || impact.planAcceptanceSource !== "demo_signup") {
      throw new Error("Doctor impact does not match its coverage change");
    }
    if (fact.direction === "worsened" && fact.resolvedByChangeId === null) matched.add(fact.id);
  }
  return alerts.filter((alert) => matched.has(alert.id));
}

export async function loadAggregateCoverageChanges(): Promise<CoverageChangeInput[]> {
  const file = process.env.COVERAGE_ALERTS_PAYLOAD || "data/raw/coverage-alerts.json";
  try {
    // Runtime deployment data is staged separately, never bundled from an arbitrary path.
    return aggregateCoverageChanges(JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, "utf8")), process.env.COVERAGE_ALERTS_NPI);
  } catch {
    // Never silently substitute fake alerts for a broken configured source.
    throw new ApiError(503, "Aggregate alerts are unavailable. Publish a valid pipeline payload with npm run demo:prepare or configure COVERAGE_ALERTS_PAYLOAD.");
  }
}
