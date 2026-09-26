import type { Alternative } from "@/lib/contract";

/** Mirrors lib/contract.ts. Swap these exports for that import once it is on this branch. */
export type ChangeType = "tier_increase" | "removed" | "new_prior_auth" | "new_step_therapy" | "new_quantity_limit";
export type AlertStatus = "new" | "seen" | "switched" | "patient_notified" | "dismissed";
export interface PatientAlert {
  id: string; patientId: string; patientName: string; age: number; language: string; planName: string;
  rxcui: string; drugName: string; displayName: string;
  changeType: ChangeType;
  oldTier: number | null; newTier: number | null;
  oldMonthlyCost: number | null; newMonthlyCost: number | null;
  monthlyIncrease: number | null; percentIncrease: number | null;
  effectiveDate: string; dataSource: "cms" | "synthetic";
  bestAlternative: Alternative | null;
  status: AlertStatus; switchedTo: string | null;
}
export interface Digest {
  totalAtRisk: number; totalMonthlyIncrease: number; totalMonthlySavingsIfSwitched: number;
  alerts: PatientAlert[]; generatedAt: string;
}
export interface PatientMessage {
  alertId: string; language: string; text: string; englishText: string; audioUrl: string | null;
}
