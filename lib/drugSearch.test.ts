import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { MAX_DRUG_SEARCH, searchPlanDrugs } from "./drugSearch";
import { PlanNotFoundError } from "./coverage";
import { addDrug, addPlan, TEST_PLAN } from "./testing";

const OTHER_PLAN = { contractId: "H0002", planId: "001", segmentId: "000" };

describe("searchPlanDrugs (synthetic)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db); // TEST_PLAN on formulary F1
    await addDrug(db, { rxcui: "1", name: "atorvastatin 40 MG Oral Tablet [Lipitor]", ingredient: "I1", tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "2", name: "atorvastatin 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "3", name: "metformin 500 MG Oral Tablet", ingredient: "I2", tier: 1, unit: 1 });
    // in the drug cache, but not on TEST_PLAN's formulary at all (tier omitted)
    await addDrug(db, { rxcui: "4", name: "atorvastatin 80 MG Oral Tablet", ingredient: "I1" });
    // a different plan, different formulary, with an overlapping-name drug
    await addPlan(db, OTHER_PLAN, "F2", "Plan Two");
    await addDrug(db, { rxcui: "5", name: "atorvastatin 20 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 1 }, OTHER_PLAN, "F2");
  });
  afterAll(async () => {
    await db.close();
  });

  it("matches on name, case-insensitively, anywhere in the string", async () => {
    const results = await searchPlanDrugs(TEST_PLAN, "ATOR", { db });
    expect(results.map((d) => d.rxcui).sort()).toEqual(["1", "2"]);
  });

  it("computes displayName: brand in brackets, else the first three words", async () => {
    const byRxcui = new Map((await searchPlanDrugs(TEST_PLAN, "atorvastatin", { db })).map((d) => [d.rxcui, d]));
    expect(byRxcui.get("1")).toMatchObject({ drugName: "atorvastatin 40 MG Oral Tablet [Lipitor]", displayName: "Lipitor" });
    expect(byRxcui.get("2")).toMatchObject({ drugName: "atorvastatin 10 MG Oral Tablet", displayName: "atorvastatin 10 MG" });
  });

  it("only returns drugs on THIS plan's own formulary", async () => {
    const results = await searchPlanDrugs(TEST_PLAN, "atorvastatin", { db });
    expect(results.some((d) => d.rxcui === "4")).toBe(false); // cached but not on any formulary
    expect(results.some((d) => d.rxcui === "5")).toBe(false); // on Plan Two's formulary, not this plan's
    expect(await searchPlanDrugs(OTHER_PLAN, "atorvastatin", { db })).toMatchObject([{ rxcui: "5" }]);
  });

  it("caps results at the limit (default 10, overridable)", async () => {
    for (let i = 10; i < 25; i++) {
      await addDrug(db, { rxcui: `${i}`, name: `testdrug${i} 10 MG Oral Tablet`, ingredient: `I${i}`, tier: 1, unit: 1 });
    }
    expect(await searchPlanDrugs(TEST_PLAN, "testdrug", { db })).toHaveLength(MAX_DRUG_SEARCH);
    expect(await searchPlanDrugs(TEST_PLAN, "testdrug", { db, limit: 3 })).toHaveLength(3);
  });

  it("returns [] for an empty/blank query, and throws for an unknown plan", async () => {
    expect(await searchPlanDrugs(TEST_PLAN, "", { db })).toEqual([]);
    expect(await searchPlanDrugs(TEST_PLAN, "   ", { db })).toEqual([]);
    await expect(searchPlanDrugs({ contractId: "H9999", planId: "999", segmentId: "000" }, "atorvastatin", { db })).rejects.toThrow(
      PlanNotFoundError,
    );
  });
});
