# ADR 0001: Eliquis aggregate coverage contract

- Status: Proposed
- Decision date: 2026-09-26
- Approval date: Pending
- API owner acknowledgment (Person 2): Pending
- Pipeline owner: Person 3
- UI owner: Person 1
- Baseline commit: `5163cf9902ef44717aae5cdbb9a1d59b5e36fdf2`
- Review fixture: [`../contracts/eliquis-aggregate-v1.example.json`](../contracts/eliquis-aggregate-v1.example.json)

## Decision

Build the Eliquis work as an additive, aggregate-prescriber pipeline beside the working
NovoLog patient demo. The new path watches Eliquis 5 mg (RXCUI `1364447`) and 2.5 mg
(RXCUI `1364441`) and stores no patient, prescription, or enrollment records.

The preferred source is Humana's Drug Formulary FHIR API. Redacted replay artifacts are
required for tests and demos. Humana's developer catalog currently directs developers to
review its OAuth documentation, so this decision makes no tokenless-access assumption:
<https://developers.humana.com/>.

Milestone 02 must fall back to CMS monthly formulary data unless its access spike can:

1. identify the official Humana endpoint and FHIR version;
2. document authentication, pagination, and applicable limits;
3. resolve two agreed Humana plans; and
4. capture valid, redacted responses covering both watched RXCUIs.

Exact plan ids are deliberately deferred until that spike proves which plans are resolvable.
The source decision and resulting provenance must be recorded; replay data must never be
presented as a live observation. The review fixture therefore uses `HDEMO` plan keys and
all-zero synthetic NPIs; none is an operational identifier.

## Compatibility boundary

| Concern | Existing path (retained) | New path (additive) |
|---|---|---|
| Watched drug | NovoLog FlexPen (`1653204`) | Eliquis 5 mg (`1364447`) and 2.5 mg (`1364441`) |
| Source | CMS quarterly `v1` vs monthly `v2-cms` | Humana FHIR, replay, or documented CMS monthly fallback |
| Subject | Named synthetic patients and prescriptions | Aggregate prescribers identified by NPI |
| Privacy | Minimal synthetic patient id/name plus plan and prescription relations | No patient, prescription, or enrollment data |
| Change model | Adverse-only `CoverageChange` rows | Symmetric `CoverageChangeFact` rows with reversal links |
| Workflow | `PatientAlert.status` | Separate API-owned workflow keyed to change/doctor impact |
| Consumers | Existing routes and UI | No route or UI consumer until the API owner accepts this contract |

The existing `ChangeType`, `CoverageChange`, `PatientAlert`, tables, routes, fixtures, and
tests remain unchanged. Later milestones may add the approved types below, but must not
rename or reinterpret those legacy interfaces.

## Ownership

- Person 3 owns source acquisition/replay, normalized observations, objective change facts,
  reversal links, aggregate prescriber inputs, and doctor-impact calculation.
- Person 2 owns API payload exposure and user workflow such as viewed, acknowledged, or
  acted-on state. User workflow state is not stored on `CoverageChangeFact`.
- Person 1 owns UI presentation and may group field-level facts for display.
- Shared schema/type changes require Person 2's acknowledgment before implementation.

## Additive public contract

The normative TypeScript shape is:

```ts
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
```

Timestamps are ISO 8601 strings. `rawArtifactHash` is a lowercase SHA-256 hex digest. The
normalized plan key is `(contractId, planId, segmentId)`; `sourcePlanId` preserves the source
identifier used to derive it.

Natural keys, hashed deterministically for stored ids, are:

- observation: `(source, sourceRunId, contractId, planId, segmentId, rxcui, ndc)`;
- change fact: `(oldObservationId, newObservationId, changeType)`;
- doctor impact: `(changeId, npi, sourceYear, estimate.metric)`.

## Change semantics

- Emit one fact per changed field. API/UI layers may group facts but must not discard them.
- A coverage transition emits only `coverage_removed` or `coverage_restored`; it suppresses
  incidental tier and restriction comparisons caused by the transition.
- Compare tier, prior authorization, step therapy, and quantity limit only when both
  observations are covered and both compared values are known. `null` means unknown and must
  never be coerced to `false` or produce a change.
- A quantity limit changing from false to true is `quantity_limit_added`; true to false is
  `quantity_limit_removed`. When both apply and amount/days are known, compare `amount / days`:
  a lower allowed daily rate is `quantity_limit_tightened`, and a higher rate is
  `quantity_limit_relaxed`.
- An improvement emits its own fact. Its `resolvesChangeId` points to the most recent
  unresolved adverse fact with the same plan, RXCUI, and inverse change type. The adverse
  fact's `resolvedByChangeId` points back to the improvement. Ties resolve deterministically
  by detection time and then id.
- A derived change is `simulated` if either source observation is simulated, `replay` if at
  least one is replay and neither is simulated, and otherwise `live`.
- A CMS fill or claim measure must retain its actual `metric` label. It must never be labeled
  or displayed as a patient count.

## Future additive storage

After this ADR is accepted, later milestones may propose these additive tables:

- `source_runs`
- `coverage_observations`
- `coverage_change_facts`
- `prescriber_drug_volume`
- `provider_plan_acceptance`
- `doctor_impacts`

No table is authorized by this ADR until the API owner approves the corresponding schema
proposal. Existing `coverage_changes` and `patient_alerts` remain the legacy NovoLog path.

## Approval checklist

Person 2 must explicitly acknowledge all of the following before this ADR becomes Accepted:

- [ ] normalized plan identity and preservation of `sourcePlanId`;
- [ ] nullable/unknown restriction fields;
- [ ] one fact per changed field and the canonical change names;
- [ ] symmetric reversal linkage;
- [ ] typed impact metric, suppression, provenance, and quality flags;
- [ ] absence of patient, prescription, and enrollment data;
- [ ] additive-only compatibility and ownership boundaries; and
- [ ] no unapproved dependency on an `/api/*` route.

After acknowledgment, replace `Status: Proposed`, `Approval date: Pending`, and the pending
API-owner acknowledgment above with the accepted status, date, and reviewer reference.

## Stop condition

If the aggregate/no-patient privacy model or this payload is not approved, Person 3 may finish
Milestone 01 only. Do not build both aggregate and patient-level Eliquis matching
speculatively.
