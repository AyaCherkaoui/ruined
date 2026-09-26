export type CoverageStatus = "covered" | "restricted" | "not_covered";

export interface Plan {
  contractId: string;
  planId: string;
  segmentId: string;
  planName: string;
}

export interface Patient {
  id: string;
  name: string;
  age: number;
  language: string;
  plan: Plan;
  meds: { rxcui: string; drugName: string; dose: string }[];
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

export interface DashboardResponse {
  totalPatients: number;
  patientsOverpaying: number;
  totalPotentialMonthlySavings: number;
  atRisk: { patient: Patient; worstDrug: CoverageResult; bestAlternative: Alternative | null }[];
}

export interface CoverageAlert {
  patientId: string;
  patientName: string;
  drugName: string;
  oldTier: number;
  newTier: number;
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
}

export interface DrugOption { rxcui: string; drugName: string; displayName: string; }

export interface UpcomingRisk {
  patientId: string; patientName: string; age: number; language: string;
  rxcui: string; drugName: string; displayName: string;
  oldTier: number; newTier: number;
  oldMonthlyCost: number | null; newMonthlyCost: number | null;
  percentIncrease: number | null;
  effectiveDate: string;
  bestAlternative: Alternative | null;
}
