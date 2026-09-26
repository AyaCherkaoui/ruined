import type { PlanKey } from "./coverage";
import type { Db } from "./db";
import { saveDrug } from "./drugs";

// Helpers for building tiny synthetic worlds in an in-memory database, so tests can control every number.
// Test-only: nothing outside *.test.ts imports this.

export const TEST_PLAN: PlanKey = { contractId: "H0001", planId: "001", segmentId: "000" };
export const TEST_FORMULARY = "F1";

export async function addPlan(db: Db, key: PlanKey = TEST_PLAN, formularyId = TEST_FORMULARY, planName = "Test Plan") {
  await db.run(
    `INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id, snp)
     VALUES ('v1', $1, $2, $3, $4, $5, '0')`,
    [key.contractId, key.planId, key.segmentId, planName, formularyId],
  );
}

/** type 1 = copay ($), 2 = coinsurance (0.25 = 25%) */
export async function addTier(db: Db, tier: number, type: 1 | 2, amount: number, key: PlanKey = TEST_PLAN, specialty = false) {
  await db.run(
    `INSERT INTO beneficiary_cost (data_version, contract_id, plan_id, segment_id, coverage_level, tier, days_supply,
                                   cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref, tier_specialty)
     VALUES ('v1', $1, $2, $3, 1, $4, 1, $5, $6, 0, 0, $7)`,
    [key.contractId, key.planId, key.segmentId, tier, type, amount, specialty],
  );
}

export interface DrugFixture {
  rxcui: string;
  name: string;
  ingredient: string;
  classId?: string | null;
  tty?: string;
  form?: string;
  generic?: string | null;
  /** tier on the plan's formulary; omit for a drug the plan does not cover */
  tier?: number;
  /** per-unit 30-day cost; omit for "no price" */
  unit?: number;
  pa?: boolean;
  st?: boolean;
  ql?: boolean;
}

export async function addDrug(db: Db, d: DrugFixture, key: PlanKey = TEST_PLAN, formularyId = TEST_FORMULARY) {
  await saveDrug(db, {
    rxcui: d.rxcui,
    name: d.name,
    tty: d.tty ?? "SCD",
    ingredientRxcui: d.ingredient,
    ingredientName: d.ingredient,
    classId: d.classId === undefined ? "C10AA" : d.classId,
    className: "Test class",
    classType: "ATC1-4",
    doseFormGroup: d.form ?? "Oral Product",
    genericRxcui: d.generic ?? null,
  });
  if (d.tier === undefined) return;
  await db.run(
    `INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug)
     VALUES ('v1', $1, $2, $3, $4, $5, $6, $7, false)`,
    [formularyId, d.rxcui, `NDC${d.rxcui}`, d.tier, d.ql ?? false, d.pa ?? false, d.st ?? false],
  );
  if (d.unit !== undefined) {
    await db.run(
      `INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost)
       VALUES ('v1', $1, $2, $3, $4, 30, $5)`,
      [key.contractId, key.planId, key.segmentId, `NDC${d.rxcui}`, d.unit],
    );
  }
}

export async function addPatient(
  db: Db,
  p: { id: string; name: string; age?: number; language?: string },
  plan: PlanKey,
  meds: [rxcui: string, drugName: string][],
) {
  await db.run(
    "INSERT INTO patients (id, name, age, language, contract_id, plan_id, segment_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [p.id, p.name, p.age ?? 70, p.language ?? "English", plan.contractId, plan.planId, plan.segmentId],
  );
  for (const [rxcui, drugName] of meds) {
    await db.run("INSERT INTO patient_meds (patient_id, rxcui, drug_name, dose) VALUES ($1, $2, $3, '1 daily')", [p.id, rxcui, drugName]);
  }
}
