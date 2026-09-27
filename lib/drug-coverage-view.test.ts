import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CheckResponse, CoverageChange, PatientAlert } from "./contract";
import { buildDrugPlanRows } from "./drug-coverage-view";
import { policyMessage } from "./pipeline/policy-notification";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const change = (id: string, over: Partial<CoverageChange>): CoverageChange => ({
  id, fromVersion: "v1", toVersion: "v2-cms", formularyId: "F1", rxcui: "111", drugName: "Drug A 10 MG",
  changeType: "new_prior_auth", oldTier: 3, newTier: 3, oldPriorAuth: false, newPriorAuth: true,
  oldStepTherapy: false, newStepTherapy: false, oldQuantityLimit: true, newQuantityLimit: true,
  detectedAt: "2026-09-27T00:00:00Z", ...over,
});

const alert = (patientId: string, patientName: string, over: Partial<PatientAlert>): PatientAlert => ({
  id: `a-${patientId}-${over.changeId ?? "c1"}`, changeId: "c1", changeType: "new_prior_auth", patientId, patientName,
  prescriptionId: `rx-${patientId}`, rxcui: "111", drugName: "Drug A 10 MG", contractId: "H0001", planId: "001",
  segmentId: "000", planName: "Wellcare Test Plan", oldMonthlyCost: 47, newMonthlyCost: 47, bestAlternativeRxcui: null,
  bestAlternativeCost: null, bestAlternativeName: null, status: "new", createdAt: "2026-09-27T00:00:00Z",
  fromVersion: "v1", toVersion: "v2-cms", detectedAt: "2026-09-27T00:00:00Z", oldTier: 3, newTier: 3, ...over,
});

const check = (over: Partial<CheckResponse["coverage"]> = {}): CheckResponse => ({
  coverage: { rxcui: "111", drugName: "Drug A 10 MG", status: "restricted", tier: 3, priorAuth: true, stepTherapy: false, quantityLimit: true, estMonthlyCost: 47, isEstimate: true, ...over },
  alternatives: [{ rxcui: "999", drugName: "Alt Drug 5 MG", status: "covered", tier: 1, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: 5, isEstimate: true, monthlySavings: 42 }],
});

const ALERTS = [
  alert("p1", "Alice Secretname", {}),
  alert("p2", "Bob Hiddenname", {}),
  alert("p1", "Alice Secretname", { changeId: "c2", changeType: "tier_increase", oldTier: 3, newTier: 4 }),
  alert("p3", "Carol Privatename", { contractId: "S0002", planId: "002", planName: "CareSource Plan", changeId: "c3", changeType: "removed", newMonthlyCost: null }),
];
const CHANGES = [change("c1", {}), change("c2", { changeType: "tier_increase", newTier: 4 }), change("c3", { changeType: "removed", formularyId: "F2", newTier: null })];
const CHECKS = new Map<string, CheckResponse | null>([
  ["H0001:001:000:111", check({ tier: 4 })],
  ["S0002:002:000:111", check({ status: "not_covered", tier: null, priorAuth: false, quantityLimit: false, estMonthlyCost: null })],
]);

describe("buildDrugPlanRows", () => {
  it("groups by drug, one card per plan, with every change type and a distinct-patient count", () => {
    const [group] = buildDrugPlanRows(ALERTS, CHANGES, CHECKS);
    expect(group.plans.map((p) => [p.planName, p.planIds])).toEqual([["CareSource Plan", ["S0002-002"]], ["Wellcare Test Plan", ["H0001-001"]]]);
    const wellcare = group.plans[1];
    expect(wellcare.changeTypes).toEqual(["tier_increase", "new_prior_auth"]);
    expect(wellcare.affectedPatients).toBe(2);
    expect(wellcare.before).toMatchObject({ tiers: [3, 3], priorAuth: false, quantityLimit: true, costs: [47, 47] });
    expect(wellcare.now).toMatchObject({ tiers: [4, 4], status: "restricted", priorAuth: true, costs: [47, 47] });
    expect(wellcare.alternatives[0]).toMatchObject({ name: "Alt Drug 5 MG", tier: 1, estMonthlyCost: 5 });
    expect(group.plans[0]).toMatchObject({ changeTypes: ["removed"], affectedPatients: 1, now: { status: "not_covered" } });
  });

  it("falls back to the change record when the coverage check is unavailable", () => {
    const [group] = buildDrugPlanRows([ALERTS[3]], CHANGES, new Map([["S0002:002:000:111", null]]));
    expect(group.plans[0].now).toMatchObject({ status: "unknown", tiers: null });
    expect(group.plans[0].alternatives).toEqual([]);
  });

  it("shows each plan ONCE per drug: strengths and same-named plans merge into one card", () => {
    const tenMg = { rxcui: "112", drugName: "dapagliflozin 10 MG Oral Tablet [Farxiga]" };
    const fiveMg = { rxcui: "113", drugName: "dapagliflozin 5 MG Oral Tablet [Farxiga]", oldMonthlyCost: 40 };
    const alt = (rxcui: string, drugName: string, cost: number) => ({ rxcui, drugName, status: "covered" as const, tier: 3, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: cost, isEstimate: true as const, monthlySavings: 1 });
    const notCovered = (name: string, alts: ReturnType<typeof alt>[]): CheckResponse => ({ coverage: { rxcui: "x", drugName: name, status: "not_covered", tier: null, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: null, isEstimate: true }, alternatives: alts });
    const jardiance = [alt("j10", "empagliflozin 10 MG Oral Tablet [Jardiance]", 47), alt("j25", "empagliflozin 25 MG Oral Tablet [Jardiance]", 47)];
    const groups = buildDrugPlanRows(
      [
        alert("p1", "A", { ...tenMg, changeType: "removed" }),
        alert("p2", "B", { ...tenMg, changeType: "removed", contractId: "H0009", planId: "009" }),
        alert("p3", "C", { ...fiveMg, changeType: "removed" }),
      ],
      [],
      new Map([
        ["H0001:001:000:112", notCovered(tenMg.drugName, jardiance)],
        ["H0009:009:000:112", notCovered(tenMg.drugName, jardiance)],
        ["H0001:001:000:113", notCovered(fiveMg.drugName, jardiance)],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].drugName).toBe("Farxiga");
    expect(groups[0].plans).toHaveLength(1);
    const [card] = groups[0].plans;
    expect(card).toMatchObject({ strengths: ["5 MG", "10 MG"], planIds: ["H0001-001", "H0009-009"], affectedPatients: 3, now: { status: "not_covered" } });
    expect(card.before.costs).toEqual([40, 47]);
    expect(card.alternatives).toEqual([expect.objectContaining({ name: "Jardiance", strengths: ["10 MG", "25 MG"], estMonthlyCost: 47 })]);
  });

  it("carries no patient fields in its output", () => {
    const json = JSON.stringify(buildDrugPlanRows(ALERTS, CHANGES, CHECKS));
    for (const secret of ["Secretname", "Hiddenname", "Privatename", "p1", "p2", "p3", "rx-p"]) expect(json).not.toContain(secret);
  });
});

describe("DrugCoverageDashboard", () => {
  it("renders drugs, plans, tiers, restrictions and costs, and no patient names", async () => {
    const { DrugCoverageDashboard } = await import("../components/drug-coverage-dashboard");
    const html = renderToStaticMarkup(createElement(DrugCoverageDashboard, { groups: buildDrugPlanRows(ALERTS, CHANGES, CHECKS), affectedPatients: 3 }));
    for (const text of ["Wellcare Test Plan", "CareSource Plan", "Tier 3", "Tier 4", "Prior authorization", "est. $47.00", "Not covered", "Alt Drug 5 MG", "Higher formulary tier"]) {
      expect(html).toContain(text);
    }
    for (const secret of ["Secretname", "Hiddenname", "Privatename"]) expect(html).not.toContain(secret);
  });
});

describe("policyMessage", () => {
  it("is generic: only the patient count and the link", () => {
    expect(policyMessage(70, "https://headsuphealth.tech/")).toBe("HeadsUp: A coverage change affects 70 of your patients. Review in HeadsUp: https://headsuphealth.tech/");
    expect(policyMessage(1, "https://headsuphealth.tech/")).toContain("affects 1 of your patients.");
  });
});

describe("WhatsApp message privacy", () => {
  it("never names insurers, plans, drugs, or patients", async () => {
    const { notifyPolicyChanges } = await import("./pipeline/policy-notification");
    expect(typeof notifyPolicyChanges).toBe("function");
    const msg = policyMessage(3, "https://headsuphealth.tech/");
    for (const leak of ["Wellcare", "CareSource", "Farxiga", "Byetta", "exenatide", "Plan", "Secretname", "demo", "synthetic"]) expect(msg).not.toContain(leak);
  });
});
