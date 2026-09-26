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
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
  bestAlternativeRxcui: string | null;
  bestAlternativeCost: number | null;
  status: PatientAlertStatus;
  createdAt: string;
}
