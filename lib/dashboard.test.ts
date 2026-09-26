import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDashboard, HIGH_COST_MIN, OVERPAYING_MIN_SAVINGS } from "./dashboard";
import { dbPath, openDb, type Db } from "./db";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";

// ---------------------------------------------------------------------------------------
// Synthetic plan with numbers we control. Tiers: 1 = $0 copay, 2 = $10 copay, 3 = 25% coinsurance.
// ---------------------------------------------------------------------------------------
describe("buildDashboard (synthetic)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db);
    await addTier(db, 1, 1, 0);
    await addTier(db, 2, 1, 10);
    await addTier(db, 3, 2, 0.25);

    // Expensive, and nothing else in its class (A10BK): 30 x $20 = $600 -> 25% = $150, no alternative exists
    await addDrug(db, { rxcui: "1", name: "bigpharm 10 MG Oral Tablet [Bigpharm]", ingredient: "E1", classId: "A10BK", tier: 3, unit: 20, tty: "SBD" });
    // Cheap generic whose alternative saves only a little: drug costs $5 (< $10 copay); alternative is free -> saves $5
    await addDrug(db, { rxcui: "2", name: "statinol 10 MG Oral Tablet", ingredient: "G1", tier: 2, unit: 5 / 30 });
    await addDrug(db, { rxcui: "3", name: "statinex 10 MG Oral Tablet", ingredient: "G2", tier: 1, unit: 0.1 });
    // Brand statin at 25% coinsurance: 30 x $2 = $60 -> $15; free alternative saves $15 (>= $10)
    await addDrug(db, { rxcui: "4", name: "statinbrand 10 MG Oral Tablet [Statinbrand]", ingredient: "G3", tier: 3, unit: 2, tty: "SBD" });
    // Not on the plan's formulary
    await addDrug(db, { rxcui: "5", name: "uncovered 10 MG Oral Tablet", ingredient: "U1", classId: "A10BJ" });

    await addPatient(db, { id: "a", name: "Ann Expensive" }, TEST_PLAN, [["2", "statinol"], ["1", "bigpharm"]]);
    await addPatient(db, { id: "b", name: "Bea Generic" }, TEST_PLAN, [["2", "statinol"], ["3", "statinex"]]);
    await addPatient(db, { id: "c", name: "Cal Savings" }, TEST_PLAN, [["4", "statinbrand"], ["3", "statinex"]]);
    await addPatient(db, { id: "d", name: "Dee Uncovered" }, TEST_PLAN, [["5", "uncovered"], ["3", "statinex"]]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("flags patients with a high-cost drug, a meaningful saving, or a not-covered drug, and not the rest", async () => {
    const d = await buildDashboard(db);
    expect(d.totalPatients).toBe(4);
    expect(d.patientsOverpaying).toBe(3);
    expect(d.atRisk.map((r) => r.patient.id)).toEqual(["c", "a", "d"]); // biggest saving first, then by name
  });

  it("does not let a tiny saving on a cheap generic hide a $150 drug (regression)", async () => {
    // Ann takes statinol ($5, a $5 saving exists) and bigpharm ($150, no alternative). The worst drug must be bigpharm.
    const ann = (await buildDashboard(db)).atRisk.find((r) => r.patient.id === "a")!;
    expect(ann.worstDrug).toMatchObject({ rxcui: "1", estMonthlyCost: 150, tier: 3 });
    expect(ann.bestAlternative).toBeNull();
    expect(ann.worstDrug.estMonthlyCost!).toBeGreaterThanOrEqual(HIGH_COST_MIN);
  });

  it("shows the alternative and its savings for a patient flagged for overpaying", async () => {
    const cal = (await buildDashboard(db)).atRisk.find((r) => r.patient.id === "c")!;
    expect(cal.worstDrug).toMatchObject({ rxcui: "4", estMonthlyCost: 15 });
    expect(cal.bestAlternative).toMatchObject({ rxcui: "3", estMonthlyCost: 0, monthlySavings: 15 });
    expect(cal.bestAlternative!.monthlySavings).toBeGreaterThanOrEqual(OVERPAYING_MIN_SAVINGS);
  });

  it("flags a drug the plan does not cover, and does not flag a patient with only small savings (Bea saves $5)", async () => {
    const d = await buildDashboard(db);
    expect(d.atRisk.find((r) => r.patient.id === "d")!.worstDrug).toMatchObject({ rxcui: "5", status: "not_covered", estMonthlyCost: null });
    expect(d.atRisk.map((r) => r.patient.id)).not.toContain("b");
  });

  it("totals the savings that are shown", async () => {
    const d = await buildDashboard(db);
    expect(d.totalPotentialMonthlySavings).toBe(d.atRisk.reduce((s, r) => s + (r.bestAlternative?.monthlySavings ?? 0), 0));
    expect(d.totalPotentialMonthlySavings).toBe(15);
  });
});

describe("buildDashboard (empty roster)", () => {
  it("returns zeros, not an error", async () => {
    const db = await openDb({ path: ":memory:" });
    expect(await buildDashboard(db)).toEqual({ totalPatients: 0, patientsOverpaying: 0, totalPotentialMonthlySavings: 0, atRisk: [] });
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------
// Real seeded roster. Numbers verified independently in Python from the raw CMS tables.
// ---------------------------------------------------------------------------------------
describe.skipIf(!fs.existsSync(dbPath()))("buildDashboard (seeded Georgia roster)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it("finds the 9 patients who are overpaying or carry a high-cost drug", async () => {
    // 6 base cases (unchanged since task 8) + pt-009/pt-018/pt-020: the `api` branch's task 1
    // added Rybelsus (oral semaglutide, ~$960/mo retail) to 4 generic-only patients after it was
    // found removed from every roster plan in the real September 2026 CMS monthly PUF (see
    // lib/patientAlerts.test.ts); 3 of the 4 cross HIGH_COST_MIN on their own plan's v1 cost share
    // (pt-012's copay plan keeps her at exactly $47, still under $100, so she stays unflagged here).
    const d = await buildDashboard(db);
    expect(d.totalPatients).toBe(20);
    expect(d.patientsOverpaying).toBe(9);
    expect(d.atRisk.map((r) => r.patient.id)).toEqual([
      "pt-007", "pt-005", "pt-004", // ranked by alternative savings (unchanged)
      "pt-020", "pt-009", "pt-001", "pt-006", "pt-003", "pt-018", // no alternative -> tied at 0, alphabetical by name
    ]);
    expect(d.totalPotentialMonthlySavings).toBe(298.86); // 101.17 + 100.86 + 96.83 (Rybelsus has no alternative -- see task 1)
  });

  it("Tradjenta -> Januvia for pt-004: $126.14 vs $29.31, saves $96.83", async () => {
    const r = (await buildDashboard(db)).atRisk.find((x) => x.patient.id === "pt-004")!;
    expect(r.worstDrug).toMatchObject({ rxcui: "1100706", tier: 3, estMonthlyCost: 126.14 });
    expect(r.bestAlternative).toMatchObject({ estMonthlyCost: 29.31, monthlySavings: 96.83 });
    expect(r.bestAlternative!.drugName).toContain("Januvia");
  });

  it("Myrbetriq for pt-007 ($110.49) has a $9.32 alternative; Ozempic / Toujeo / Trulicity are flagged by cost alone", async () => {
    const d = await buildDashboard(db);
    const pt7 = d.atRisk.find((x) => x.patient.id === "pt-007")!;
    expect(pt7.worstDrug.estMonthlyCost).toBe(110.49);
    expect(pt7.bestAlternative).toMatchObject({ estMonthlyCost: 9.32, monthlySavings: 101.17 });
    for (const [id, cost] of [["pt-001", 264.97], ["pt-006", 274.82], ["pt-003", 249.17]] as const) {
      const r = d.atRisk.find((x) => x.patient.id === id)!;
      expect(r.worstDrug.estMonthlyCost).toBe(cost);
      expect(r.bestAlternative).toBeNull();
    }
  });

  it("does not flag the patients whose meds are still all cheap generics", async () => {
    // pt-009/pt-018/pt-020 are excluded here on purpose: task 1 gave them a genuinely expensive
    // drug (Rybelsus), so they now belong in the flagged list above, not this one.
    const ids = (await buildDashboard(db)).atRisk.map((r) => r.patient.id);
    for (const id of ["pt-008", "pt-010", "pt-011", "pt-012", "pt-013", "pt-014", "pt-015", "pt-016", "pt-017", "pt-019"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("every at-risk worst drug is one of the patient's own meds", async () => {
    for (const r of (await buildDashboard(db)).atRisk) {
      expect(r.patient.meds.map((m) => m.rxcui)).toContain(r.worstDrug.rxcui);
    }
  });
});
