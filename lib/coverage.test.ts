import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkCoverage,
  coverageStatus,
  monthlyQuantity,
  patientCost,
  PlanNotFoundError,
  pickCostShare,
  qlPer30Days,
  typicalQuantity,
  type CostRow,
} from "./coverage";
import { dbPath, openDb, type Db } from "./db";

// ---------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------

describe("pickCostShare", () => {
  const row = (over: Partial<CostRow>): CostRow => ({
    tier: 1,
    coverage_level: 1,
    cost_type_pref: 1,
    cost_amt_pref: 0,
    cost_min_amt_pref: 0,
    cost_max_amt_pref: 0,
    cost_type_nonpref: 1,
    cost_amt_nonpref: 10,
    cost_min_amt_nonpref: 0,
    cost_max_amt_nonpref: 0,
    tier_specialty: false,
    ...over,
  });

  it("uses standard retail by default and preferred when asked", () => {
    expect(pickCostShare(row({}))).toEqual({ type: 1, amount: 10, min: 0, max: 0 });
    expect(pickCostShare(row({}), "preferred")).toEqual({ type: 1, amount: 0, min: 0, max: 0 });
  });
  it("falls back to the other pharmacy type when one is 'not offered' (type 0)", () => {
    expect(pickCostShare(row({ cost_type_nonpref: 0, cost_amt_nonpref: 0 }))).toEqual({ type: 1, amount: 0, min: 0, max: 0 });
    expect(pickCostShare(row({ cost_type_pref: 0, cost_amt_pref: 0 }), "preferred")?.amount).toBe(10);
  });
  it("returns null when neither is offered", () => {
    expect(pickCostShare(row({ cost_type_pref: 0, cost_type_nonpref: 0 }))).toBeNull();
    expect(pickCostShare(row({ cost_type_pref: null, cost_type_nonpref: null }))).toBeNull();
  });
});

describe("patientCost", () => {
  it("copay is flat but never exceeds the drug's cost", () => {
    expect(patientCost({ type: 1, amount: 10, min: 0, max: 0 }, 250)).toBe(10);
    expect(patientCost({ type: 1, amount: 10, min: 0, max: 0 }, 4)).toBe(4);
    expect(patientCost({ type: 1, amount: 0, min: 0, max: 0 }, 250)).toBe(0);
  });
  it("coinsurance is a fraction of the drug cost", () => {
    expect(patientCost({ type: 2, amount: 0.25, min: 0, max: 0 }, 200)).toBe(50);
  });
  it("coinsurance respects min and max dollar amounts", () => {
    expect(patientCost({ type: 2, amount: 0.25, min: 15, max: 0 }, 20)).toBe(15);
    expect(patientCost({ type: 2, amount: 0.25, min: 0, max: 100 }, 1000)).toBe(100);
    expect(patientCost({ type: 2, amount: 0.25, min: 15, max: 100 }, 200)).toBe(50);
  });
});

describe("typicalQuantity", () => {
  it("is null with no quantity limits", () => {
    expect(typicalQuantity([])).toBeNull();
  });
  it("returns the value when every plan agrees", () => {
    expect(typicalQuantity(Array(20).fill(30))).toBe(30);
    expect(typicalQuantity([60])).toBe(60);
  });
  it("finds the steady dose, not the loading-dose ceiling (Eliquis 5 mg: 21 plans say 74, 6 say 60)", () => {
    expect(typicalQuantity([...Array(21).fill(74), ...Array(6).fill(60)])).toBe(60);
  });
  it("ignores a lone outlier plan", () => {
    expect(typicalQuantity([15, ...Array(9).fill(30)])).toBe(30);
  });
  it("prefers the majority when the smaller value is only a small minority", () => {
    expect(typicalQuantity([...Array(28).fill(30), ...Array(4).fill(60)])).toBe(30);
    expect(typicalQuantity([...Array(28).fill(60), 30])).toBe(60);
  });
});

describe("monthlyQuantity / qlPer30Days", () => {
  it("scales a quantity limit to 30 days", () => {
    expect(qlPer30Days(2, 28)).toBeCloseTo(2.143, 3);
    expect(qlPer30Days(30, 30)).toBe(30);
    expect(qlPer30Days(null, 30)).toBeNull();
    expect(qlPer30Days(5, 0)).toBeNull();
  });
  it("defaults to one a day for oral products and one unit for other forms when no plan sets a QL", () => {
    expect(monthlyQuantity(null, null, "Oral Product")).toBe(30);
    expect(monthlyQuantity(null, null, null)).toBe(30);
    expect(monthlyQuantity(null, null, "Injectable Product")).toBe(1);
  });
  it("uses the drug's typical quantity, capped by this plan's own (lower) QL", () => {
    expect(monthlyQuantity(60, null, "Oral Product")).toBe(60);
    expect(monthlyQuantity(60, 74, "Oral Product")).toBe(60);
    expect(monthlyQuantity(60, 30, "Oral Product")).toBe(30);
  });
});

describe("coverageStatus", () => {
  const none = { priorAuth: false, stepTherapy: false, quantityLimit: false };
  it("is covered with no restrictions", () => expect(coverageStatus(none)).toBe("covered"));
  it("is restricted with any of PA / ST / QL", () => {
    expect(coverageStatus({ ...none, priorAuth: true })).toBe("restricted");
    expect(coverageStatus({ ...none, stepTherapy: true })).toBe("restricted");
    expect(coverageStatus({ ...none, quantityLimit: true })).toBe("restricted");
  });
});

// ---------------------------------------------------------------------------------------
// Real data: CMS Q2 2026 SPUF, Georgia, data_version 'v1' (npm run: python scripts/load_spuf.py)
// Expected values were computed independently in Python from the raw rows
// (formulary tier/flags, 30-day unit cost, level-1 standard-retail cost share, drug-typical quantity).
// ---------------------------------------------------------------------------------------

const hasDb = fs.existsSync(dbPath());

const DRUGS = {
  atorvastatin: "617311", // atorvastatin 40 MG Oral Tablet
  lisinopril: "314076", // lisinopril 10 MG Oral Tablet
  metformin: "861007", // metformin hydrochloride 500 MG Oral Tablet
  amlodipine: "197361", // amlodipine 5 MG Oral Tablet
  eliquis: "1364447", // apixaban 5 MG Oral Tablet [Eliquis]
  dapagliflozin: "1488574", // dapagliflozin 5 MG Oral Tablet (generic)
  synthroid: "966247", // levothyroxine sodium 0.05 MG Oral Tablet [Synthroid] (brand)
};

const PLANS: { label: string; key: [string, string, string]; expected: Record<keyof typeof DRUGS, { tier: number; ql: boolean; cost: number }> }[] = [
  {
    // MA-PD with flat copays on every tier
    label: "H0439-006-000 HealthSpring Preferred Plus (HMO), copay design",
    key: ["H0439", "006", "000"],
    expected: {
      atorvastatin: { tier: 1, ql: true, cost: 4.0 }, // copay $10 but the drug only costs $4.00
      lisinopril: { tier: 1, ql: false, cost: 5.12 },
      metformin: { tier: 1, ql: true, cost: 9.51 },
      amlodipine: { tier: 1, ql: false, cost: 1.95 },
      eliquis: { tier: 3, ql: false, cost: 47.0 }, // tier-3 copay
      dapagliflozin: { tier: 3, ql: true, cost: 47.0 },
      synthroid: { tier: 3, ql: false, cost: 47.0 },
    },
  },
  {
    // PDP that puts brand drugs on 25% coinsurance
    label: "S5884-135-000 Humana Basic Rx Plan (PDP), 25% coinsurance on tier 3",
    key: ["S5884", "135", "000"],
    expected: {
      atorvastatin: { tier: 2, ql: false, cost: 1.0 },
      lisinopril: { tier: 1, ql: false, cost: 0 },
      metformin: { tier: 1, ql: false, cost: 0 },
      amlodipine: { tier: 1, ql: false, cost: 0 },
      eliquis: { tier: 3, ql: true, cost: 62.18 }, // 60 tablets x $4.1451 x 25%
      dapagliflozin: { tier: 3, ql: true, cost: 45.4 },
      synthroid: { tier: 3, ql: false, cost: 12.56 },
    },
  },
  {
    // PDP with 16% coinsurance and a $13 tier-1 copay
    label: "S5921-392-000 AARP Medicare Rx Preferred (PDP), 16% coinsurance on tier 3",
    key: ["S5921", "392", "000"],
    expected: {
      atorvastatin: { tier: 1, ql: false, cost: 8.31 },
      lisinopril: { tier: 1, ql: true, cost: 12.92 },
      metformin: { tier: 1, ql: true, cost: 13.0 }, // $17.70 drug cost, capped by the $13 copay
      amlodipine: { tier: 1, ql: false, cost: 5.9 },
      eliquis: { tier: 3, ql: true, cost: 39.79 },
      dapagliflozin: { tier: 3, ql: true, cost: 29.04 },
      synthroid: { tier: 3, ql: false, cost: 8.49 },
    },
  },
];

describe.skipIf(!hasDb)("checkCoverage on real Georgia Part D data (5+ common drugs)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
  });
  afterAll(async () => {
    await db.close();
  });

  for (const plan of PLANS) {
    describe(plan.label, () => {
      for (const [drug, rxcui] of Object.entries(DRUGS)) {
        const exp = plan.expected[drug as keyof typeof DRUGS];
        it(`${drug}: tier ${exp.tier}, est. $${exp.cost}/month`, async () => {
          const r = await checkCoverage(...plan.key, rxcui, { db });
          expect(r.rxcui).toBe(rxcui);
          expect(r.tier).toBe(exp.tier);
          expect(r.quantityLimit).toBe(exp.ql);
          expect(r.priorAuth).toBe(false);
          expect(r.stepTherapy).toBe(false);
          expect(r.status).toBe(exp.ql ? "restricted" : "covered");
          expect(r.estMonthlyCost).toBeCloseTo(exp.cost, 2);
          expect(r.isEstimate).toBe(true);
        });
      }
    });
  }

  it("names drugs from the drug cache (RxNorm names)", async () => {
    const r = await checkCoverage("H0439", "006", "000", DRUGS.atorvastatin, { db });
    expect(r.drugName).toBe("atorvastatin 40 MG Oral Tablet");
    const e = await checkCoverage("H0439", "006", "000", DRUGS.eliquis, { db });
    expect(e.drugName).toBe("apixaban 5 MG Oral Tablet [Eliquis]");
  });

  it("flags prior authorization (Ozempic pen on H0439-006: tier 3 copay, PA + quantity limit)", async () => {
    const r = await checkCoverage("H0439", "006", "000", "2619154", { db });
    expect(r).toMatchObject({ status: "restricted", tier: 3, priorAuth: true, stepTherapy: false, quantityLimit: true });
    expect(r.drugName).toContain("Ozempic");
    expect(r.estMonthlyCost).toBe(47); // $1,052.58 of drug (3.21 mL x $327.91/mL), capped by the $47 tier-3 copay
  });

  it("flags step therapy and prices a specialty tier (Exxua on H0439-006: tier 5, 25% coinsurance)", async () => {
    const r = await checkCoverage("H0439", "006", "000", "2672379", { db });
    expect(r).toMatchObject({ status: "restricted", tier: 5, priorAuth: false, stepTherapy: true, quantityLimit: true });
    expect(r.estMonthlyCost).toBeCloseTo(433.52, 2); // 30 tablets x $57.8027 = $1,734.08 x 25%
  });

  it("reports a drug missing from the plan's formulary as not_covered with no cost", async () => {
    // Kaiser's formulary does not list Synthroid 50 mcg
    const r = await checkCoverage("H1170", "002", "000", DRUGS.synthroid, { db });
    expect(r).toMatchObject({
      status: "not_covered",
      tier: null,
      priorAuth: false,
      stepTherapy: false,
      quantityLimit: false,
      estMonthlyCost: null,
      isEstimate: true,
    });
  });

  it("supports a preferred-pharmacy estimate and a known-dose override", async () => {
    // Standard retail tier-1 copay is $10 on H0439-006; preferred retail is $0
    const preferred = await checkCoverage("H0439", "006", "000", DRUGS.metformin, { db, pharmacy: "preferred" });
    expect(preferred.estMonthlyCost).toBe(0);
    // 60 metformin tablets at $0.0634 = $3.80 (below the $10 copay, so the patient pays the drug cost)
    const dosed = await checkCoverage("H0439", "006", "000", DRUGS.metformin, { db, quantityPer30Days: 60 });
    expect(dosed.estMonthlyCost).toBeCloseTo(3.8, 2);
  });

  it("throws PlanNotFoundError for an unknown plan", async () => {
    await expect(checkCoverage("H9999", "999", "000", DRUGS.atorvastatin, { db })).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
