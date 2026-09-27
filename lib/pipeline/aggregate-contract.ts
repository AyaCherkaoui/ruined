export type CoverageSource = "humana_fhir" | "cms_monthly";
export type CoverageProvenance = "live" | "replay" | "simulated";

export interface CoveragePlanKey {
  contractId: string;
  planId: string;
  segmentId: string;
  sourcePlanId: string;
}

export interface QuantityLimitObservation {
  applies: boolean | null;
  amount: number | null;
  days: number | null;
}

export interface CoverageObservation {
  id: string;
  source: CoverageSource;
  sourceReleaseId: string;
  sourceRunId: string;
  plan: CoveragePlanKey;
  rxcui: string;
  ndc: string | null;
  covered: boolean;
  tier: number | null;
  priorAuthorization: boolean | null;
  stepTherapy: boolean | null;
  quantityLimit: QuantityLimitObservation;
  capturedAt: string;
  effectiveAt: string | null;
  rawArtifactHash: string;
  provenance: CoverageProvenance;
}

export type CoverageChangeDirection = "worsened" | "improved";

export type CoverageChangeFactType =
  | "coverage_removed"
  | "coverage_restored"
  | "tier_increased"
  | "tier_decreased"
  | "prior_authorization_added"
  | "prior_authorization_removed"
  | "step_therapy_added"
  | "step_therapy_removed"
  | "quantity_limit_added"
  | "quantity_limit_removed"
  | "quantity_limit_tightened"
  | "quantity_limit_relaxed";

export interface CoverageChangeFact {
  id: string;
  oldObservationId: string;
  newObservationId: string;
  plan: CoveragePlanKey;
  rxcui: string;
  direction: CoverageChangeDirection;
  changeType: CoverageChangeFactType;
  detectedAt: string;
  effectiveAt: string | null;
  resolvesChangeId: string | null;
  resolvedByChangeId: string | null;
  provenance: CoverageProvenance;
}

export type DoctorImpactMetric =
  | "unique_beneficiaries"
  | "total_claims"
  | "thirty_day_fills";

export type DoctorImpactMethod =
  | "cms_reported_value"
  | "cms_suppressed"
  | "derived_range";

export type DoctorImpactQualityFlag =
  | "missing_source_value"
  | "ingredient_level_volume"
  | "not_plan_specific"
  | "simulated_source"
  | "suppressed_source_value"
  | "demo_plan_acceptance"
  | "simulated_change"
  | "source_name_normalized"
  | "stale_source_year";

export interface DoctorImpactEstimate {
  metric: DoctorImpactMetric;
  value: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  method: DoctorImpactMethod;
}

export interface DoctorImpact {
  id: string;
  npi: string;
  changeId: string;
  plan: CoveragePlanKey;
  rxcui: string;
  estimate: DoctorImpactEstimate;
  sourceYear: number;
  suppressed: boolean;
  qualityFlags: DoctorImpactQualityFlag[];
  planAcceptanceSource: "demo_signup";
}

export interface EliquisAggregatePayloadV1 {
  contractVersion: "eliquis-aggregate-v1";
  observations: CoverageObservation[];
  changes: CoverageChangeFact[];
  doctorImpacts: DoctorImpact[];
}
