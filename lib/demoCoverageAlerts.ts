import type { CoverageChangeInput } from "./coverageAlerts";

// =====================================================================================
//  DEMO / MOCK DATA -- TEMPORARY. NOT REAL COVERAGE CHANGES.
// =====================================================================================
// Simulated Eliquis coverage changes on two Humana plans, so the Coverage Watchdog demo
// always shows an alert. Replaced by Person 3's Humana pipeline loader (see
// coverageAlertStore() in lib/coverageAlerts.ts). Every row here has isDemo: true.
//
// The plan ids are real Humana Part D plans from the CMS files already in this repo.
// S5884-135's baseline (Eliquis 5 mg on tier 3 with a quantity limit, no PA) is real
// Q2 2026 CMS data (see lib/coverage.test.ts). The CHANGES and the effective date are made up.
//
// No patients here. estimatedPatientRange is left out until CMS prescriber matching exists.
// =====================================================================================

const ELIQUIS_5MG = { drug: "Eliquis (apixaban) 5 mg tablet", rxcui: "1364447" };

const DEMO = {
  insurer: "Humana",
  effectiveDate: "2026-11-01",
  detectedAt: "2026-09-26T13:00:00.000Z",
  source: "DEMO: simulated second snapshot of the Humana formulary (not a real change)",
  sourceUrl: null,
  isDemo: true,
} as const;

export const DEMO_COVERAGE_CHANGES: readonly CoverageChangeInput[] = [
  {
    ...DEMO,
    ...ELIQUIS_5MG,
    id: "demo-eliquis-s5884-135-prior-auth-added",
    planId: "S5884-135",
    planName: "Humana Basic Rx Plan (PDP)",
    changeType: "prior_auth_added",
    oldValue: "Covered on tier 3 with a quantity limit. No prior authorization.",
    newValue: "Covered on tier 3 with a quantity limit. Prior authorization required.",
  },
  {
    ...DEMO,
    ...ELIQUIS_5MG,
    id: "demo-eliquis-h5216-073-tier-increase",
    planId: "H5216-073",
    planName: "HumanaChoice",
    changeType: "tier_increase",
    oldValue: "Tier 3 (preferred brand).",
    newValue: "Tier 4 (non-preferred drug).",
  },
];

export async function loadDemoCoverageChanges(): Promise<CoverageChangeInput[]> {
  return [...DEMO_COVERAGE_CHANGES];
}
