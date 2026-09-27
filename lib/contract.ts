export type CoverageStatus = "covered" | "restricted" | "not_covered";

export interface Plan {
  contractId: string;
  planId: string;
  segmentId: string;
  planName: string;
}

// A patient is an id and a name. Nothing else about the patient, ever -- see DATA_MODEL.md.
export interface Patient {
  id: string;
  fullName: string;
}

export interface Doctor {
  id: string;
  fullName: string;
  phone: string | null;
}

export interface Prescription {
  id: string;
  patientId: string;
  doctorId: string;
  rxcui: string;
  startedAt: string; // ISO date
}

export interface CoverageResult {
  rxcui: string;
  drugName: string;
  status: CoverageStatus;
  tier: number | null;
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: boolean;
  estMonthlyCost: number | null;
  isEstimate: true;
}

export interface Alternative extends CoverageResult {
  monthlySavings: number;
}

export interface CheckResponse {
  coverage: CoverageResult;
  alternatives: Alternative[];
}

/** A patient plus the plan they are enrolled in. The plan is enrollment, not a demographic. */
export interface PatientSummary {
  id: string;
  fullName: string;
  plan: Plan;
}

export interface DrugOption {
  rxcui: string;
  drugName: string;
}

export type ChangeType = "removed" | "tier_increase" | "new_prior_auth" | "new_step_therapy" | "new_quantity_limit";

// Matches the coverage_changes table (see DATA_MODEL.md). drugName is joined in for
// readability, not a stored column.
export interface CoverageChange {
  id: string;
  fromVersion: string;
  toVersion: string;
  formularyId: string;
  rxcui: string;
  drugName: string;
  changeType: ChangeType;
  oldTier: number | null;
  newTier: number | null;
  oldPriorAuth: boolean;
  newPriorAuth: boolean;
  oldStepTherapy: boolean;
  newStepTherapy: boolean;
  oldQuantityLimit: boolean;
  newQuantityLimit: boolean;
  detectedAt: string;
}

export type PatientAlertStatus = "new" | "seen" | "switched" | "dismissed";

// Matches the patient_alerts table, joined with the patient's full name and the
// drug/change details a doctor needs to act (see DATA_MODEL.md). Only id + fullName
// ever identify the patient.
export interface PatientAlert {
  selectedAlternative?: { rxcui: string; drugName: string; estMonthlyCost: number | null; savedAt: string } | null;
  id: string;
  changeId: string;
  changeType: ChangeType;
  patientId: string;
  patientName: string;
  prescriptionId: string;
  rxcui: string;
  drugName: string;
  contractId: string;
  planId: string;
  /** Joined from the patient's enrollment. Not a column on patient_alerts. */
  segmentId: string;
  /** Joined from the plan file for display. Not a column on patient_alerts. */
  planName: string;
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
  bestAlternativeRxcui: string | null;
  bestAlternativeCost: number | null;
  /** Joined from the drug cache. Null when there is no suggested switch. */
  bestAlternativeName: string | null;
  status: PatientAlertStatus;
  createdAt: string;
  /** Joined from coverage_changes. The versions this alert compared. */
  fromVersion: string;
  toVersion: string;
  detectedAt: string;
  oldTier: number | null;
  newTier: number | null;
}

// ---------------------------------------------------------------------------------
// Coverage Watchdog (Eliquis + Humana). Change-level alerts for a doctor: "this plan
// changed this rule for this drug". No patient identities -- the practice finds its own
// affected patients in its own records. PatientAlert above is the legacy NovoLog model.
// ---------------------------------------------------------------------------------

export type CoverageAlertChangeType =
  | "prior_auth_added"
  | "prior_auth_removed"
  | "step_therapy_added"
  | "step_therapy_removed"
  | "quantity_limit_added"
  | "quantity_limit_removed"
  | "quantity_limit_tightened"
  | "quantity_limit_relaxed"
  | "tier_increase"
  | "tier_decrease"
  | "dropped"
  | "restored";

export type CoverageAlertStatus = "open" | "resolved";

export type CoverageAlertActionType =
  | "find_affected_patients"
  | "submit_prior_auth"
  | "request_exception"
  | "cost_support";

/** One next step for the doctor, shown on the action page. `steps` are in order. */
export interface CoverageAlertAction {
  type: CoverageAlertActionType;
  title: string;
  steps: string[];
  url: string | null;
}

/** Estimated from public CMS prescriber data. Never names or identifies patients. */
export interface EstimatedPatientRange {
  min: number;
  max: number;
  basis: string;
}

export interface CoverageAlert {
  id: string;
  insurer: string;
  /** CMS contract-plan id, e.g. "S5884-135". */
  planId: string;
  planName: string;
  /** Display name, e.g. "Eliquis (apixaban) 5 mg tablet". */
  drug: string;
  rxcui: string | null;
  changeType: CoverageAlertChangeType;
  /** Headline: one sentence describing the change, ready to display. */
  summary: string;
  /** Human-readable rule before the change. Null when there was no prior rule (e.g. "restored"). */
  oldValue: string | null;
  /** Human-readable rule after the change. Null when the drug is gone (e.g. "dropped"). */
  newValue: string | null;
  /** YYYY-MM-DD. Null when the source gives no effective date. */
  effectiveDate: string | null;
  /** ISO timestamp of when our pipeline detected the change. */
  detectedAt: string;
  /** Null until CMS prescriber matching exists. */
  estimatedPatientRange: EstimatedPatientRange | null;
  status: CoverageAlertStatus;
  /** ISO timestamp. Null while open. */
  resolvedAt: string | null;
  /** True for simulated demo data. The UI can label it. */
  isDemo: boolean;
  /** Where the data came from, human-readable. */
  source: string;
  sourceUrl: string | null;
  /** Next steps, in display order. Empty when the change helps patients (e.g. "prior_auth_removed"). */
  actions: CoverageAlertAction[];
}
