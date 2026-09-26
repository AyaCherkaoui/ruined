import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Patient } from "./contract";
import { coverageForRxcuis, loadPlanContext } from "./coverage";
import { dbPath, openDb, type Db } from "./db";
import { getPatient, listPatients, MAX_PATIENT_SEARCH, searchPatients } from "./patients";

// The seeded synthetic roster (scripts/seed-patients.ts) against the real plan data.

const hasDb = fs.existsSync(dbPath());

describe.skipIf(!hasDb)("seeded synthetic patients", () => {
  let db: Db;
  let patients: Patient[];

  beforeAll(async () => {
    db = await openDb({ readOnly: true });
    patients = await listPatients(db);
    if (patients.length === 0) throw new Error("No patients in the database: run `npx tsx scripts/seed-patients.ts` first");
  });
  afterAll(async () => {
    await db.close();
  });

  it("has 20 patients with unique ids", () => {
    expect(patients).toHaveLength(20);
    expect(new Set(patients.map((p) => p.id)).size).toBe(20);
  });

  it("matches the contract's Patient shape exactly", () => {
    for (const p of patients) {
      expect(Object.keys(p).sort()).toEqual(["age", "id", "language", "meds", "name", "plan"]);
      expect(Object.keys(p.plan).sort()).toEqual(["contractId", "planId", "planName", "segmentId"]);
      expect(typeof p.age).toBe("number");
      for (const m of p.meds) expect(Object.keys(m).sort()).toEqual(["dose", "drugName", "rxcui"]);
    }
  });

  it("gives every patient 2 to 4 distinct meds", () => {
    for (const p of patients) {
      expect(p.meds.length).toBeGreaterThanOrEqual(2);
      expect(p.meds.length).toBeLessThanOrEqual(4);
      expect(new Set(p.meds.map((m) => m.rxcui)).size).toBe(p.meds.length);
    }
  });

  it("assigns every patient to a real Georgia plan (non-SNP) and fills in the plan name from the CMS data", async () => {
    for (const p of patients) {
      const rows = await db.query<{ plan_name: string; snp: string; state: string }>(
        "SELECT plan_name, snp, state FROM plans WHERE data_version = 'v1' AND contract_id = $1 AND plan_id = $2 AND segment_id = $3",
        [p.plan.contractId, p.plan.planId, p.plan.segmentId],
      );
      expect(rows, `${p.id} plan`).toHaveLength(1);
      expect(rows[0].plan_name).toBe(p.plan.planName);
      expect(rows[0].snp).toBe("0");
      expect(rows[0].state).toBe("GA");
    }
  });

  it("uses a spread of plans (both stand-alone PDPs and Medicare Advantage plans)", () => {
    const keys = new Set(patients.map((p) => `${p.plan.contractId}-${p.plan.planId}-${p.plan.segmentId}`));
    expect(keys.size).toBeGreaterThanOrEqual(10);
    expect(patients.some((p) => p.plan.contractId.startsWith("S"))).toBe(true);
    expect(patients.some((p) => p.plan.contractId.startsWith("H"))).toBe(true);
  });

  it("puts 5 to 7 patients on expensive drugs (a med costing >= $50/month on their plan)", async () => {
    let expensive = 0;
    for (const p of patients) {
      const cov = await coverageForRxcuis(db, await loadPlanContext(db, p.plan), p.meds.map((m) => m.rxcui));
      if ([...cov.values()].some((c) => (c.estMonthlyCost ?? 0) >= 50)) expensive++;
    }
    expect(expensive).toBeGreaterThanOrEqual(5);
    expect(expensive).toBeLessThanOrEqual(7);
  });

  it("only prescribes drugs the patient's plan covers (so a v1 -> v2 tier change is a real change)", async () => {
    for (const p of patients) {
      const cov = await coverageForRxcuis(db, await loadPlanContext(db, p.plan), p.meds.map((m) => m.rxcui));
      for (const c of cov.values()) expect(c.status, `${p.id} ${c.drugName}`).not.toBe("not_covered");
    }
  });

  it("getPatient returns the same record as the list, and null for an unknown id", async () => {
    expect(await getPatient("pt-001", db)).toEqual(patients.find((p) => p.id === "pt-001"));
    expect(await getPatient("nope", db)).toBeNull();
  });

  it("uses patient ids that are visibly synthetic", () => {
    for (const p of patients) expect(p.id).toMatch(/^pt-\d{3}$/);
  });

  it("searchPatients matches names case-insensitively, substring anywhere in the name", async () => {
    expect((await searchPatients("eve", 8, db)).map((p) => p.name)).toEqual(["Evelyn Park"]);
    expect((await searchPatients("EVE", 8, db)).map((p) => p.name)).toEqual(["Evelyn Park"]);
    expect((await searchPatients("Park", 8, db)).map((p) => p.name)).toEqual(["Evelyn Park"]);
  });

  it("searchPatients returns [] for no match or an empty/blank query", async () => {
    expect(await searchPatients("zzznotaname", 8, db)).toEqual([]);
    expect(await searchPatients("", 8, db)).toEqual([]);
    expect(await searchPatients("   ", 8, db)).toEqual([]);
  });

  it("searchPatients caps results at the given limit (default 8)", async () => {
    const uncapped = await searchPatients("a", 100, db);
    expect(uncapped.length).toBeGreaterThan(MAX_PATIENT_SEARCH); // 16 of the 20 seeded names contain "a"
    expect(await searchPatients("a", undefined, db)).toHaveLength(MAX_PATIENT_SEARCH);
    expect(await searchPatients("a", 3, db)).toHaveLength(3);
  });

  it("searchPatients returns full Patient records (meds included), matching the contract shape", async () => {
    const [evelyn] = await searchPatients("evelyn", 8, db);
    expect(evelyn).toEqual(patients.find((p) => p.id === "pt-007"));
    expect(evelyn.meds.length).toBeGreaterThan(0);
  });
});
