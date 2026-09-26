import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classAllowsAlternatives, compareAlternatives, findAlternatives } from "./alternatives";
import type { CoverageResult } from "./contract";
import { PlanNotFoundError } from "./coverage";
import { openDb, type Db } from "./db";
import { saveDrug, type DrugRecord } from "./drugs";

// ---------------------------------------------------------------------------------------
// Synthetic world so ranking rules are tested against numbers we control.
// One plan, tiers: 1 = $5 copay, 2 = $10 copay, 3 = 25% coinsurance. All oral, 30 units/month.
// ---------------------------------------------------------------------------------------

const PLAN = { contractId: "H0001", planId: "001", segmentId: "000" };
const FORMULARY = "F1";
const CLASS = "C10AA"; // a real chronic-care ATC class (statins), so the class guardrail lets it through

interface Fx {
  rxcui: string;
  name: string;
  ingredient: string;
  tier: number;
  unit: number | null; // per-unit cost; null = no price row
  cls?: string | null;
  form?: string;
  onFormulary?: boolean;
  pa?: boolean;
  st?: boolean;
  ql?: boolean;
  tty?: string;
  generic?: string | null;
}

const FIXTURES: Fx[] = [
  // source: brand, tier 3 coinsurance: 30 x $10 = $300 -> patient $75
  { rxcui: "100", name: "Brandex 10 MG Oral Tablet [Brandex]", ingredient: "I1", tier: 3, unit: 10, tty: "SBD", generic: "101" },
  // its generic: tier 1, 30 x $0.5 = $15 -> copay $5   (savings 70)
  { rxcui: "101", name: "genericol 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 0.5, tty: "SCD" },
  // same ingredient as the source but a different strength and NOT its generic -> must be excluded
  { rxcui: "110", name: "genericol 20 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 0.5, tty: "SCD" },
  // other ingredient, prior auth -> ranks below every unrestricted option even though $10 < $20
  { rxcui: "102", name: "altamed 5 MG Oral Tablet", ingredient: "I2", tier: 2, unit: 1, pa: true },
  // ingredient I3, two strengths: the ingredient is represented by its WORST-CASE product (103, $10), never the cheap one (104, $3)
  { rxcui: "103", name: "trialin 5 MG Oral Tablet", ingredient: "I3", tier: 2, unit: 2 },
  { rxcui: "104", name: "trialin 10 MG Oral Tablet", ingredient: "I3", tier: 1, unit: 0.1 },
  // costlier than the source (25% of $600 = $150) -> excluded unless includeCostlier
  { rxcui: "105", name: "pricey 10 MG Oral Tablet", ingredient: "I4", tier: 3, unit: 20 },
  // injectable, wrong route family -> excluded
  { rxcui: "106", name: "injecta 10 MG/ML Injection", ingredient: "I5", tier: 1, unit: 0.1, form: "Injectable Product" },
  // different class -> excluded
  { rxcui: "107", name: "otherclass 10 MG Oral Tablet", ingredient: "I6", tier: 1, unit: 0.1, cls: "Y20BB" },
  // in the class but not on this plan's formulary -> excluded
  { rxcui: "108", name: "notcovered 10 MG Oral Tablet", ingredient: "I7", tier: 1, unit: 0.1, onFormulary: false },
  // on the formulary but no price -> cannot be ranked -> excluded
  { rxcui: "109", name: "noprice 10 MG Oral Tablet", ingredient: "I8", tier: 1, unit: null },
  // specialty-tier (tier 4 is flagged specialty by this plan): never a source, never an alternative even though 114 looks cheap
  { rxcui: "113", name: "orphanix 10 MG Oral Tablet", ingredient: "I12", tier: 4, unit: 100 },
  { rxcui: "114", name: "orphanette 10 MG Oral Tablet", ingredient: "I13", tier: 4, unit: 0.1 },
  // a starter pack / kit (RxNorm GPCK): one-time titration product, must never be suggested even though it looks cheap
  { rxcui: "112", name: "{28 (starterin 10 MG Oral Tablet) } Pack [Starterin Kit]", ingredient: "I11", tier: 1, unit: 0.01, tty: "GPCK" },
  // fourth good option, unrestricted: $90 drug cost, capped by the $10 tier-2 copay
  { rxcui: "111", name: "fourthin 10 MG Oral Tablet", ingredient: "I9", tier: 2, unit: 3 },
  // a drug the plan does not cover (used as an uncovered source)
  { rxcui: "120", name: "uncovered 10 MG Oral Tablet", ingredient: "I10", tier: 1, unit: null, onFormulary: false },
  // combination product: no class -> no alternatives
  { rxcui: "130", name: "combo 5 MG / 10 MG Oral Tablet", ingredient: "M1", tier: 1, unit: 0.1, cls: null },
];

let db: Db;

beforeAll(async () => {
  db = await openDb({ path: ":memory:" });
  await db.run(`INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id)
                VALUES ('v1', $1, $2, $3, 'Test Plan', $4)`, [PLAN.contractId, PLAN.planId, PLAN.segmentId, FORMULARY]);
  const costs: [number, number, number][] = [
    [1, 1, 5],
    [2, 1, 10],
    [3, 2, 0.25],
    [4, 2, 0.25], // specialty tier
  ];
  for (const [tier, type, amt] of costs) {
    await db.run(
      `INSERT INTO beneficiary_cost (data_version, contract_id, plan_id, segment_id, coverage_level, tier, days_supply,
                                     cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref, tier_specialty)
       VALUES ('v1', $1, $2, $3, 1, $4, 1, $5, $6, 0, 0, $7)`,
      [PLAN.contractId, PLAN.planId, PLAN.segmentId, tier, type, amt, tier === 4],
    );
  }
  for (const f of FIXTURES) {
    const record: DrugRecord = {
      rxcui: f.rxcui,
      name: f.name,
      tty: f.tty ?? "SCD",
      ingredientRxcui: f.ingredient,
      ingredientName: f.ingredient,
      classId: f.cls === undefined ? CLASS : f.cls,
      className: "Test class",
      classType: "ATC1-4",
      doseFormGroup: f.form ?? "Oral Product",
      genericRxcui: f.generic ?? null,
    };
    await saveDrug(db, record);
    if (f.onFormulary !== false) {
      await db.run(
        `INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug)
         VALUES ('v1', $1, $2, $3, $4, $5, $6, $7, false)`,
        [FORMULARY, f.rxcui, `NDC${f.rxcui}`, f.tier, f.ql ?? false, f.pa ?? false, f.st ?? false],
      );
      if (f.unit !== null) {
        await db.run(
          `INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost)
           VALUES ('v1', $1, $2, $3, $4, 30, $5)`,
          [PLAN.contractId, PLAN.planId, PLAN.segmentId, `NDC${f.rxcui}`, f.unit],
        );
      }
    }
  }
});

afterAll(async () => {
  await db.close();
});

const rxcuis = (alts: { rxcui: string }[]) => alts.map((a) => a.rxcui);

describe("findAlternatives (synthetic plan)", () => {
  it("returns the top 3: unrestricted first, then lowest cost, one per ingredient", async () => {
    const alts = await findAlternatives(PLAN, "100", { db });
    // 101 generic of the brand $5; then 111 fourthin and 103 trialin, both $10 tier 2 (tie -> name order).
    // 102 is also $10 but has a PA, so it ranks below every unrestricted option.
    expect(rxcuis(alts)).toEqual(["101", "111", "103"]);
    expect(alts.map((a) => a.estMonthlyCost)).toEqual([5, 10, 10]);
    expect(alts.map((a) => a.monthlySavings)).toEqual([70, 65, 65]); // vs the brand's $75
  });

  it("puts restricted options after unrestricted ones even when they are cheaper", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 10 });
    expect(rxcuis(alts)).toEqual(["101", "111", "103", "102"]);
    expect(alts[3]).toMatchObject({ priorAuth: true, status: "restricted", estMonthlyCost: 10 });
  });

  it("represents an ingredient by its worst-case strength so savings hold whichever strength is chosen", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 10 });
    expect(rxcuis(alts)).toContain("103"); // $10
    expect(rxcuis(alts)).not.toContain("104"); // the $3 strength of the same ingredient is not shown
    expect(alts.find((a) => a.rxcui === "103")?.monthlySavings).toBe(65); // 75 - 10, not 75 - 3
  });

  it("never suggests starter packs / kits", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 50, includeCostlier: true });
    expect(rxcuis(alts)).not.toContain("112");
  });

  it("includes the generic equivalent of a brand source but no other strength of the same ingredient", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 10 });
    expect(rxcuis(alts)).toContain("101");
    expect(rxcuis(alts)).not.toContain("110");
  });

  it("excludes wrong class, wrong route, uncovered, unpriced, and the source itself", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 50, includeCostlier: true });
    for (const bad of ["100", "104", "106", "107", "108", "109", "110", "112", "113", "114"]) expect(rxcuis(alts)).not.toContain(bad);
  });

  it("excludes options that cost more than the current drug unless asked", async () => {
    expect(rxcuis(await findAlternatives(PLAN, "100", { db, limit: 50 }))).not.toContain("105");
    const all = await findAlternatives(PLAN, "100", { db, limit: 50, includeCostlier: true });
    expect(rxcuis(all)).toContain("105");
    expect(all.find((a) => a.rxcui === "105")?.monthlySavings).toBe(-75); // $150 vs $75
  });

  it("returns [] when nothing is cheaper (source is already the cheapest option)", async () => {
    // 104 is $3/month; every other ingredient in the class has a worst-case cost of at least $5
    expect(await findAlternatives(PLAN, "104", { db })).toEqual([]);
  });

  it("never returns more than the limit, and defaults to 3", async () => {
    expect((await findAlternatives(PLAN, "100", { db })).length).toBe(3);
    expect((await findAlternatives(PLAN, "100", { db, limit: 1 })).length).toBe(1);
  });

  it("returns full CoverageResult fields plus monthlySavings", async () => {
    const [best] = await findAlternatives(PLAN, "100", { db });
    expect(best).toEqual({
      rxcui: "101",
      drugName: "genericol 10 MG Oral Tablet",
      status: "covered",
      tier: 1,
      priorAuth: false,
      stepTherapy: false,
      quantityLimit: false,
      estMonthlyCost: 5,
      isEstimate: true,
      monthlySavings: 70,
    });
  });

  it("offers covered options with 0 savings when the current drug is not covered at all", async () => {
    // No cost to beat, so nothing is filtered by price. Ingredient I1 is represented by its worst-case
    // product (the $75 brand, not its $5 generic): 111 and 103 are $10, 100 is $75; 102 has a PA and 105 costs $150.
    const alts = await findAlternatives(PLAN, "120", { db });
    expect(rxcuis(alts)).toEqual(["111", "103", "100"]);
    expect(alts.every((a) => a.monthlySavings === 0)).toBe(true);
  });

  it("returns [] for a drug with no known class (e.g. a combination product)", async () => {
    expect(await findAlternatives(PLAN, "130", { db })).toEqual([]);
  });

  it("throws PlanNotFoundError for an unknown plan", async () => {
    await expect(findAlternatives({ contractId: "H9", planId: "999", segmentId: "000" }, "100", { db })).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });
});

describe("specialty-tier guardrail", () => {
  it("gives a specialty-tier drug no alternatives", async () => {
    expect(await findAlternatives(PLAN, "113", { db, includeCostlier: true })).toEqual([]);
  });
  it("never offers a specialty-tier drug as an alternative (114 would be the cheapest at $0.75)", async () => {
    const alts = await findAlternatives(PLAN, "100", { db, limit: 50, includeCostlier: true });
    expect(rxcuis(alts)).not.toContain("114");
    expect(rxcuis(alts)).not.toContain("113");
  });
});

describe("classAllowsAlternatives (curated interchangeable classes)", () => {
  it("allows classes where in-class substitution is routine", () => {
    for (const id of ["C10AA", "C09AA", "A10BK", "A10BJ", "A10BH", "B01AF", "N06AB", "A02BC", "G04CA", "S01EE"]) {
      expect(classAllowsAlternatives(id)).toBe(true);
    }
  });
  it("blocks classes where a swap is clinically hazardous or meaningless (found by scanning real plans)", () => {
    const hazardous: Record<string, string> = {
      N02AA: "opioids (equianalgesic dosing)",
      N06BA: "stimulants",
      N05BA: "benzodiazepines (clobazam is an antiepileptic)",
      N03AF: "antiepileptics",
      N05AH: "antipsychotics (clozapine is for resistant schizophrenia)",
      C01BD: "antiarrhythmics (Multaq vs amiodarone)",
      B01AB: "heparins (enoxaparin vs IV heparin)",
      R03AC: "beta-2 agonists (maintenance LABA vs rescue SABA)",
      A10AB: "insulins (U-500 vs U-100 analogs)",
      H03AA: "thyroid hormones (levothyroxine vs liothyronine)",
      A01AB: "oral-cavity anti-infectives (ATC quirk)",
      A07AA: "intestinal antibiotics (vancomycin vs nystatin)",
      C01EB: "other cardiac preparations (ranolazine vs ibuprofen ATC quirk)",
    };
    for (const id of Object.keys(hazardous)) expect(classAllowsAlternatives(id), hazardous[id]).toBe(false);
  });
  it("blocks oncology, immunology, anti-infective and residual 'other ...' classes", () => {
    for (const id of ["L01EF", "L01XX", "L04AB", "J05AP", "J01CA", "N06AX", "A10BX", "C10AX", "N03AX"]) {
      expect(classAllowsAlternatives(id)).toBe(false);
    }
  });
});

describe("findAlternatives class guardrails", () => {
  it("returns [] for a source in an excluded class, even when same-class candidates exist", async () => {
    const db2 = await openDb({ path: ":memory:" });
    await db2.run(`INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id) VALUES ('v1', 'H0001', '001', '000', 'P', 'F1')`);
    for (const [rxcui, ingredient] of [["1", "A"], ["2", "B"]]) {
      await saveDrug(db2, { rxcui, name: `onc${rxcui} 10 MG Oral Tablet`, tty: "SCD", ingredientRxcui: ingredient, ingredientName: ingredient, classId: "L01EF", className: "CDK inhibitors", classType: "ATC1-4", doseFormGroup: "Oral Product", genericRxcui: null });
      await db2.run(`INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug) VALUES ('v1', 'F1', $1, $2, 1, false, false, false, false)`, [rxcui, `N${rxcui}`]);
      await db2.run(`INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost) VALUES ('v1', 'H0001', '001', '000', $1, 30, $2)`, [`N${rxcui}`, rxcui === "1" ? 500 : 5]);
    }
    await db2.run(`INSERT INTO beneficiary_cost (data_version, contract_id, plan_id, segment_id, coverage_level, tier, days_supply, cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref) VALUES ('v1', 'H0001', '001', '000', 1, 1, 1, 2, 0.25, 0, 0)`);
    expect(await findAlternatives(PLAN, "1", { db: db2 })).toEqual([]);
    await db2.close();
  });

  it("still offers a brand's exact generic in an excluded class, but no other same-class drug", async () => {
    // H03AA thyroid hormones: Synthroid-like brand (tier 3) -> its generic (tier 1) is fine; liothyronine is a different drug
    const db2 = await openDb({ path: ":memory:" });
    await db2.run(`INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id) VALUES ('v1', 'H0001', '001', '000', 'P', 'F1')`);
    const drugs: [string, string, string, string | null, number][] = [
      // rxcui, tty, ingredient, generic link, unit cost
      ["10", "SBD", "LEVO", "11", 2],
      ["11", "SCD", "LEVO", null, 0.1],
      ["12", "SCD", "LIO", null, 0.05], // cheap liothyronine in the same class: must NOT be suggested
    ];
    for (const [rxcui, tty, ingredient, generic, unit] of drugs) {
      await saveDrug(db2, { rxcui, name: `d${rxcui} 50 MCG Oral Tablet`, tty, ingredientRxcui: ingredient, ingredientName: ingredient, classId: "H03AA", className: "Thyroid hormones", classType: "ATC1-4", doseFormGroup: "Oral Product", genericRxcui: generic });
      await db2.run(`INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug) VALUES ('v1', 'F1', $1, $2, $3, false, false, false, false)`, [rxcui, `N${rxcui}`, rxcui === "10" ? 3 : 1]);
      await db2.run(`INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost) VALUES ('v1', 'H0001', '001', '000', $1, 30, $2)`, [`N${rxcui}`, unit]);
    }
    for (const [tier, amt] of [[1, 5], [3, 40]]) {
      await db2.run(`INSERT INTO beneficiary_cost (data_version, contract_id, plan_id, segment_id, coverage_level, tier, days_supply, cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref) VALUES ('v1', 'H0001', '001', '000', 1, $1, 1, 1, $2, 0, 0)`, [tier, amt]);
    }
    const alts = await findAlternatives(PLAN, "10", { db: db2 });
    expect(alts.map((a) => a.rxcui)).toEqual(["11"]);
    expect(alts[0].monthlySavings).toBe(37); // brand: 30 x $2 = $60 -> $40 copay; generic: 30 x $0.1 = $3
    await db2.close();
  });
});

describe("compareAlternatives", () => {
  const c = (over: Partial<CoverageResult>): CoverageResult => ({
    rxcui: "1",
    drugName: "a",
    status: "covered",
    tier: 1,
    priorAuth: false,
    stepTherapy: false,
    quantityLimit: false,
    estMonthlyCost: 10,
    isEstimate: true,
    ...over,
  });
  it("orders by restriction, then cost, then tier, then name, then rxcui", () => {
    expect(compareAlternatives(c({ quantityLimit: true, estMonthlyCost: 1 }), c({ estMonthlyCost: 99 }))).toBeGreaterThan(0);
    expect(compareAlternatives(c({ estMonthlyCost: 5 }), c({ estMonthlyCost: 6 }))).toBeLessThan(0);
    expect(compareAlternatives(c({ tier: 1 }), c({ tier: 2 }))).toBeLessThan(0);
    expect(compareAlternatives(c({ drugName: "a" }), c({ drugName: "b" }))).toBeLessThan(0);
    expect(compareAlternatives(c({ rxcui: "1" }), c({ rxcui: "2" }))).toBeLessThan(0);
  });
  it("treats step therapy and prior auth as restrictions too", () => {
    expect(compareAlternatives(c({ stepTherapy: true }), c({}))).toBeGreaterThan(0);
    expect(compareAlternatives(c({ priorAuth: true }), c({}))).toBeGreaterThan(0);
  });
});
