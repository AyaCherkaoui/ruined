import { describe, expect, it } from "vitest";
import type { Alternative, PatientAlert } from "./contract";
import { attentionSummary, costComparison, medicineLabel, patientTimeline, policyFilters, rankReason, reviewCounts, whySteps } from "./medishift-view";

function alert(overrides: Partial<PatientAlert> = {}): PatientAlert {
  return {
    id: "a1",
    changeId: "c1",
    changeType: "removed",
    patientId: "pt-1",
    patientName: "Ava Rahman",
    prescriptionId: "rx-1",
    rxcui: "1",
    drugName: "10 MG dapagliflozin [Farxiga]",
    contractId: "H0111",
    planId: "001",
    segmentId: "000",
    planName: "Wellcare Simple Open (PPO)",
    oldMonthlyCost: 45.4,
    newMonthlyCost: null,
    bestAlternativeRxcui: null,
    bestAlternativeCost: null,
    bestAlternativeName: null,
    status: "new",
    createdAt: "2026-09-26 12:00:00",
    fromVersion: "v1",
    toVersion: "v2-cms",
    detectedAt: "2026-09-26 11:00:00",
    oldTier: 3,
    newTier: null,
    ...overrides,
  };
}

function alt(overrides: Partial<Alternative> = {}): Alternative {
  return {
    rxcui: "2",
    drugName: "25 MG empagliflozin [Jardiance]",
    status: "restricted",
    tier: 3,
    priorAuth: false,
    stepTherapy: false,
    quantityLimit: true,
    estMonthlyCost: 50.95,
    isEstimate: true,
    monthlySavings: 0,
    ...overrides,
  };
}

describe("medicine labels", () => {
  it("keeps the strength so two Farxiga doses are not the same filter", () => {
    expect(medicineLabel(alert())).toBe("Farxiga 10 MG");
    expect(medicineLabel(alert({ drugName: "dapagliflozin 5 MG Oral Tablet [Farxiga]" }))).toBe("Farxiga 5 MG");
    expect(medicineLabel(alert({ drugName: "60 ACTUAT exenatide 0.01 MG/ACTUAT Pen Injector" }))).toBe("exenatide 0.01 MG/ACTUAT");
  });
});

describe("medicine filters", () => {
  it("gives one filter per medicine across doses and plans", () => {
    const filters = policyFilters([
      alert(),
      alert({ id: "a2", drugName: "dapagliflozin 5 MG Oral Tablet [Farxiga]", planName: "Wellcare Simple (HMO-POS)" }),
      alert({ id: "a3", drugName: "60 ACTUAT exenatide 0.01 MG/ACTUAT Pen Injector" }),
      alert({ id: "a4", drugName: "60 ACTUAT exenatide 0.005 MG/ACTUAT Pen Injector" }),
    ]);
    expect(filters.map((filter) => filter.label)).toEqual(["Farxiga", "exenatide"]);
  });
});

describe("review counts and attention", () => {
  it("counts patients once and keeps a session selection out of switched", () => {
    const rows = [
      alert(),
      alert({ id: "a2", patientId: "pt-2", patientName: "Benito Alvarez", status: "seen" }),
      alert({ id: "a3", patientId: "pt-3", patientName: "Camille Brooks", status: "switched" }),
    ];
    expect(reviewCounts(rows)).toEqual({ total: 3, pending: 1, reviewed: 2, switched: 1 });
  });

  it("derives what to do first from status and the first-ranked price", () => {
    const summary = attentionSummary([
      { alert: alert(), alternatives: [alt({ estMonthlyCost: 50.95 })] },
      { alert: alert({ id: "a2", patientId: "pt-2", status: "seen", oldMonthlyCost: 73.74 }), alternatives: [alt({ estMonthlyCost: 0 })] },
    ]);
    expect(summary).toEqual({ needsDecision: 1, resolved: 1, belowLastCovered: 1, zeroEstimates: 1 });
  });
});

describe("ranking explanation", () => {
  it("says the first option is first because it costs less, not because it is clinically equivalent", () => {
    const first = alt({ rxcui: "j", estMonthlyCost: 50.95 });
    const second = alt({ rxcui: "i", drugName: "100 MG canagliflozin [Invokana]", estMonthlyCost: 409.57 });
    expect(rankReason(first, [first, second])).toMatch(/lower than the next option/);
    expect(rankReason(second, [first, second])).toBeNull();
  });

  it("does not claim a cost win when the estimates match", () => {
    const first = alt({ rxcui: "c", estMonthlyCost: 0, drugName: "8 MG candesartan" });
    const second = alt({ rxcui: "i", estMonthlyCost: 0, drugName: "75 MG irbesartan" });
    expect(rankReason(first, [first, second])).toMatch(/drug name/);
  });
});

describe("why, timeline, and cost comparison", () => {
  it("builds the flag chain from alert fields", () => {
    const steps = whySteps(alert());
    expect(steps.map((step) => step.title)).toEqual([
      "Formulary update",
      "Farxiga removed",
      "Ava Rahman is taking it",
      "The plan no longer covers it",
    ]);
  });

  it("times only events that have a timestamp, including a failed notification", () => {
    const events = patientTimeline(
      alert({ status: "switched", bestAlternativeName: "25 MG empagliflozin [Jardiance]" }),
      { drugName: "Jardiance", at: "2026-09-27T04:00:00.000Z" },
      { ok: false, at: "2026-09-27T04:01:00.000Z", error: "Live delivery is not implemented.", deliveryStatus: null },
    );
    expect(events.map((event) => event.title)).toEqual([
      "Formulary change detected",
      "Patient matched",
      "Alternative recorded",
      "Alternative selected this session",
      "Notification failed",
    ]);
    expect(events[2]?.at).toBeNull();
    expect(events[4]?.detail).toMatch(/not implemented/);
  });

  it("keeps a $0.00 engine estimate in the difference instead of dropping it", () => {
    const result = costComparison([
      { alert: alert({ oldMonthlyCost: 45.4 }), alternatives: [alt({ estMonthlyCost: 50.95 })] },
      { alert: alert({ id: "a2", patientId: "pt-2", patientName: "Derek Okonkwo", oldMonthlyCost: 73.74 }), alternatives: [alt({ estMonthlyCost: 0, drugName: "8 MG candesartan" })] },
    ]);
    expect(result.currentTotal).toBe(119.14);
    expect(result.potentialTotal).toBe(50.95);
    expect(result.reduction).toBe(68.19);
    expect(result.zeroEstimates).toBe(1);
  });
});
