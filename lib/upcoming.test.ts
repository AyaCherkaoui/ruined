import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUpcomingRisks, UPCOMING_EFFECTIVE_DATE } from "./upcoming";
import { dbPath, openDb, type Db } from "./db";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";

// ---------------------------------------------------------------------------------------
// Synthetic world. Tiers: 1 = $0 copay, 2 = $10 copay, 3 = 25% coinsurance.
// v2 = copy of v1 with two drugs' tiers raised on the one plan/formulary in play.
// ---------------------------------------------------------------------------------------
describe("buildUpcomingRisks (synthetic)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db); // TEST_PLAN, formulary F1
    await addTier(db, 1, 1, 0);
    await addTier(db, 2, 1, 10);
    await addTier(db, 3, 2, 0.25);

    // alphastatin and betastatin share an interchangeable class (addDrug's default classId,
    // C10AA, is on the allowlist) and the same oral dose form, so betastatin is a valid alternative.
    await addDrug(db, { rxcui: "1", name: "alphastatin 10 MG Oral Tablet", ingredient: "I1", tier: 2, unit: 10 }); // v1 $10 (30 x $10 x 25%... see below)
    await addDrug(db, { rxcui: "2", name: "betastatin 10 MG Oral Tablet", ingredient: "I2", tier: 1, unit: 5 }); // stays $0 in both versions
    // its own (non-interchangeable) class, so it never gets a same-class alternative
    await addDrug(db, { rxcui: "3", name: "gammadrug 10 MG Oral Tablet", ingredient: "I3", classId: null, tier: 1, unit: 1 });

    await addPatient(db, { id: "p1", name: "Ann", age: 70, language: "English" }, TEST_PLAN, [
      ["1", "alphastatin"],
      ["3", "gammadrug"],
    ]);

    for (const t of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
      await db.run(`INSERT INTO ${t} SELECT * REPLACE ('v2' AS data_version) FROM ${t} WHERE data_version = 'v1'`);
    }
    await db.run("UPDATE formulary SET tier = 3 WHERE data_version = 'v2' AND formulary_id = 'F1' AND rxcui = '1'"); // $10 -> $75
    await db.run("UPDATE formulary SET tier = 2 WHERE data_version = 'v2' AND formulary_id = 'F1' AND rxcui = '3'"); // $0 -> $10
  });
  afterAll(async () => {
    await db.close();
  });

  it("builds one UpcomingRisk per adverse change, matching the contract shape", async () => {
    const risks = await buildUpcomingRisks(db);
    expect(risks).toHaveLength(2);
    expect(Object.keys(risks[0]).sort()).toEqual(
      [
        "age",
        "bestAlternative",
        "displayName",
        "drugName",
        "effectiveDate",
        "language",
        "newMonthlyCost",
        "newTier",
        "oldMonthlyCost",
        "oldTier",
        "patientId",
        "patientName",
        "percentIncrease",
        "rxcui",
      ].sort(),
    );
  });

  it("carries the patient's age/language and a fixed effectiveDate", async () => {
    const [top] = await buildUpcomingRisks(db);
    expect(top).toMatchObject({ patientId: "p1", patientName: "Ann", age: 70, language: "English", effectiveDate: UPCOMING_EFFECTIVE_DATE });
    expect(UPCOMING_EFFECTIVE_DATE).toBe("2027-01-01");
  });

  it("sorts by dollar increase (largest first) and computes percentIncrease, null when the old cost was $0", async () => {
    const risks = await buildUpcomingRisks(db);
    expect(risks.map((r) => [r.rxcui, r.oldMonthlyCost, r.newMonthlyCost, r.percentIncrease])).toEqual([
      ["1", 10, 75, 650], // alphastatin: +$65, (75-10)/10 x 100
      ["3", 0, 10, null], // gammadrug: +$10, but +Infinity% is not a number -> null
    ]);
  });

  it("computes bestAlternative under the UPCOMING (v2) rules, not v1's", async () => {
    const [alphastatin] = await buildUpcomingRisks(db);
    // betastatin costs $0 under both versions; the saving shown is against alphastatin's NEW ($75) cost
    expect(alphastatin.bestAlternative).toMatchObject({ rxcui: "2", estMonthlyCost: 0, monthlySavings: 75 });
  });

  it("bestAlternative is null when nothing qualifies (gammadrug has no interchangeable class)", async () => {
    const [, gammadrug] = await buildUpcomingRisks(db);
    expect(gammadrug.rxcui).toBe("3");
    expect(gammadrug.bestAlternative).toBeNull();
  });

  it("with no v2 loaded, there is nothing upcoming", async () => {
    const empty = await openDb({ path: ":memory:" });
    await addPlan(empty);
    await addTier(empty, 1, 1, 0);
    await addDrug(empty, { rxcui: "1", name: "solodrug 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 1 });
    await addPatient(empty, { id: "p1", name: "Ann" }, TEST_PLAN, [["1", "solodrug"]]);
    expect(await buildUpcomingRisks(empty)).toEqual([]);
    await empty.close();
  });
});

// ---------------------------------------------------------------------------------------
// Real data: v1 = CMS Q2 2026, v2 = synthetic copy built by scripts/make-v2.ts (see changes.test.ts).
// Pinned figures cross-checked against lib/changes.test.ts's real-data alerts.
// ---------------------------------------------------------------------------------------
describe.skipIf(!fs.existsSync(dbPath()))("buildUpcomingRisks (real v1 vs synthetic v2)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
    const v2 = await db.query("SELECT 1 FROM data_versions WHERE data_version = 'v2'");
    if (v2.length === 0) throw new Error("No v2 in the database: run `npx tsx scripts/make-v2.ts` first");
  });
  afterAll(async () => {
    await db.close();
  });

  it("matches the 7 seeded patients hit by the v1 -> v2 changes, biggest dollar increase first", async () => {
    const risks = await buildUpcomingRisks(db);
    expect(risks.map((r) => [r.patientId, r.oldTier, r.newTier, r.oldMonthlyCost, r.newMonthlyCost])).toEqual([
      ["pt-006", 3, 4, 274.82, 373.75], // Toujeo
      ["pt-001", 3, 4, 264.97, 360.35], // Ozempic
      ["pt-003", 3, 4, 249.17, 299.01], // Trulicity
      ["pt-004", 3, 4, 126.14, 171.56], // Tradjenta
      ["pt-007", 3, 4, 110.49, 150.27], // Myrbetriq
      ["pt-006", 1, 2, 0, 1], // lisinopril 20 mg
      ["pt-002", 1, 2, 0, 1],
    ]);
    for (const r of risks) expect(r.effectiveDate).toBe(UPCOMING_EFFECTIVE_DATE);
  });

  it("Evelyn Park (pt-007) carries her age/language and a Myrbetriq -> trospium switch that beats the incoming tier hike", async () => {
    const risks = await buildUpcomingRisks(db);
    const evelyn = risks.find((r) => r.patientId === "pt-007")!;
    expect(evelyn).toMatchObject({ patientName: "Evelyn Park", age: 83, language: "Korean", displayName: "Myrbetriq", percentIncrease: 36 });
    expect(evelyn.bestAlternative).toMatchObject({ estMonthlyCost: 9.32, monthlySavings: 140.95 });
  });

  it("gives no alternative for the two insulin/GLP-1 drugs (Toujeo, Ozempic): no safe cheaper option under v2", async () => {
    const risks = await buildUpcomingRisks(db);
    expect(risks.find((r) => r.patientId === "pt-006" && r.displayName === "Toujeo")?.bestAlternative).toBeNull();
    expect(risks.find((r) => r.patientId === "pt-001" && r.displayName === "Ozempic")?.bestAlternative).toBeNull();
  });

  it("returns null percentIncrease for the two $0 -> $1 lisinopril rows (no denominator to divide by)", async () => {
    const risks = await buildUpcomingRisks(db);
    const lisinopril = risks.filter((r) => r.drugName.startsWith("lisinopril"));
    expect(lisinopril).toHaveLength(2);
    for (const r of lisinopril) {
      expect(r.percentIncrease).toBeNull();
      expect(r.bestAlternative).toMatchObject({ estMonthlyCost: 0, monthlySavings: 1 });
    }
  });
});
