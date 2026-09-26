import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPath, openDb, type Db } from "./db";
import { searchPlanDrugs } from "./drugSearch";
import { getPatient } from "./patients";

// Real Georgia formulary data: the exact example from the task ("pt-007" / "myr" -> Myrbetriq).

describe.skipIf(!fs.existsSync(dbPath()))("searchPlanDrugs (real Georgia data)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it("pt-007's plan formulary matches 'myr' to the Myrbetriq products (brand-labeled), max 10", async () => {
    const patient = await getPatient("pt-007", db);
    if (!patient) throw new Error("pt-007 not seeded: run scripts/seed-patients.ts first");

    const results = await searchPlanDrugs(patient.plan, "myr", { db });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(results.map((r) => r.rxcui)).toContain("1300803"); // the strength pt-007 actually takes
    for (const r of results) {
      expect(r.drugName).toMatch(/mirabegron/i);
      expect(r.displayName).toBe("Myrbetriq");
    }
  });

  it("is ordered by name and case-insensitive", async () => {
    const patient = await getPatient("pt-007", db);
    const lower = await searchPlanDrugs(patient!.plan, "myrbetriq", { db });
    const upper = await searchPlanDrugs(patient!.plan, "MYRBETRIQ", { db });
    expect(upper).toEqual(lower);
    const names = lower.map((r) => r.drugName);
    expect([...names].sort()).toEqual(names);
  });
});
