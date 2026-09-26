import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAlerts, diffFormularies } from "./changes";
import { checkCoverage } from "./coverage";
import { dbPath, openDb, type Db } from "./db";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";

// ---------------------------------------------------------------------------------------
// Synthetic world. Tiers: 1 = $0 copay, 2 = $10 copay, 3 = 25%, 4 = 40%, 5 = $10 copay.
// Two plans on two different formularies (F1, F2). v2 = copy of v1 with some F1 tiers changed.
// ---------------------------------------------------------------------------------------
const P1 = TEST_PLAN;
const P2 = { contractId: "H0002", planId: "001", segmentId: "000" };

describe("change tracker (synthetic)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db, P1, "F1", "Plan One");
    await addPlan(db, P2, "F2", "Plan Two");
    for (const plan of [P1, P2]) {
      await addTier(db, 1, 1, 0, plan);
      await addTier(db, 2, 1, 10, plan);
      await addTier(db, 3, 2, 0.25, plan);
      await addTier(db, 4, 2, 0.4, plan);
      await addTier(db, 5, 1, 10, plan);
    }
    // F1 drugs (30 units/month, so total = 30 x unit):
    await addDrug(db, { rxcui: "1", name: "alphadrug 10 MG Oral Tablet", ingredient: "I1", tier: 2, unit: 10 }, P1, "F1"); // v2 tier 3: $10 -> $75
    await addDrug(db, { rxcui: "2", name: "betadrug 10 MG Oral Tablet", ingredient: "I2", tier: 3, unit: 10 }, P1, "F1"); // v2 tier 4: $75 -> $120
    await addDrug(db, { rxcui: "3", name: "gammadrug 10 MG Oral Tablet", ingredient: "I3", tier: 1, unit: 1 }, P1, "F1"); // v2 tier 2: $0 -> $10
    await addDrug(db, { rxcui: "4", name: "deltadrug 10 MG Oral Tablet", ingredient: "I4", tier: 2, unit: 10 }, P1, "F1"); // unchanged
    await addDrug(db, { rxcui: "5", name: "epsilondrug 10 MG Oral Tablet", ingredient: "I5", tier: 3, unit: 10 }, P1, "F1"); // v2 tier 1: improvement
    await addDrug(db, { rxcui: "6", name: "zetadrug 10 MG Oral Tablet", ingredient: "I6", tier: 1, unit: 1 }, P1, "F1"); // v2 tier 3, but no patient takes it
    await addDrug(db, { rxcui: "7", name: "etadrug 10 MG Oral Tablet", ingredient: "I7", tier: 2, unit: 10 }, P1, "F1"); // v2 tier 5: same $10 copay
    // F2 (Plan Two): the same alphadrug, which does NOT change on F2
    await addDrug(db, { rxcui: "1", name: "alphadrug 10 MG Oral Tablet", ingredient: "I1", tier: 2, unit: 10 }, P2, "F2");

    await addPatient(db, { id: "p1", name: "Ann" }, P1, [["1", "alphadrug"], ["3", "gammadrug"], ["5", "epsilondrug"]]);
    await addPatient(db, { id: "p2", name: "Bob" }, P1, [["1", "alphadrug"]]);
    await addPatient(db, { id: "p3", name: "Cy" }, P1, [["2", "betadrug"], ["7", "etadrug"], ["4", "deltadrug"]]);
    await addPatient(db, { id: "p4", name: "Di" }, P2, [["1", "alphadrug"]]);
  });
  afterAll(async () => {
    await db.close();
  });

  async function makeV2() {
    for (const t of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
      await db.run(`INSERT INTO ${t} SELECT * REPLACE ('v2' AS data_version) FROM ${t} WHERE data_version = 'v1'`);
    }
    for (const [rxcui, tier] of [["1", 3], ["2", 4], ["3", 2], ["5", 1], ["6", 3], ["7", 5]] as const) {
      await db.run("UPDATE formulary SET tier = $1 WHERE data_version = 'v2' AND formulary_id = 'F1' AND rxcui = $2", [tier, rxcui]);
    }
  }

  it("with no v2 loaded there is nothing to diff", async () => {
    expect(await diffFormularies(db)).toEqual([]);
    expect(await buildAlerts(db)).toEqual([]);
  });

  it("diffFormularies lists exactly the (formulary, drug) tiers that changed", async () => {
    await makeV2();
    expect(await diffFormularies(db)).toEqual([
      { formularyId: "F1", rxcui: "1", oldTier: 2, newTier: 3 },
      { formularyId: "F1", rxcui: "2", oldTier: 3, newTier: 4 },
      { formularyId: "F1", rxcui: "3", oldTier: 1, newTier: 2 },
      { formularyId: "F1", rxcui: "5", oldTier: 3, newTier: 1 },
      { formularyId: "F1", rxcui: "6", oldTier: 1, newTier: 3 },
      { formularyId: "F1", rxcui: "7", oldTier: 2, newTier: 5 },
    ]);
  });

  it("matches affected patients, ordered by biggest cost increase (then patient, then drug)", async () => {
    const alerts = await buildAlerts(db);
    expect(alerts.map((a) => `${a.patientId}:${a.drugName.split(" ")[0]}`)).toEqual([
      "p1:alphadrug", // +$65
      "p2:alphadrug", // +$65
      "p3:betadrug", // +$45
      "p1:gammadrug", // +$10
      "p3:etadrug", // same cost, but the tier moved up
    ]);
    expect(alerts[0]).toEqual({
      patientId: "p1",
      patientName: "Ann",
      drugName: "alphadrug 10 MG Oral Tablet",
      oldTier: 2,
      newTier: 3,
      oldMonthlyCost: 10,
      newMonthlyCost: 75,
    });
    expect(alerts[2]).toMatchObject({ patientId: "p3", oldTier: 3, newTier: 4, oldMonthlyCost: 75, newMonthlyCost: 120 });
  });

  it("does not alert on improvements, unchanged drugs, drugs nobody takes, or a plan on a different formulary", async () => {
    const alerts = await buildAlerts(db);
    const drugs = alerts.map((a) => a.drugName.split(" ")[0]);
    expect(drugs).not.toContain("epsilondrug"); // tier 3 -> 1 is good news
    expect(drugs).not.toContain("deltadrug"); // unchanged
    expect(drugs).not.toContain("zetadrug"); // no patient takes it
    expect(alerts.map((a) => a.patientId)).not.toContain("p4"); // Plan Two's formulary did not change
  });

  it("keeps v1 answers unchanged while v2 shows the new tier (versions are independent)", async () => {
    const v1 = await checkCoverage("H0001", "001", "000", "1", { db, dataVersion: "v1" });
    const v2 = await checkCoverage("H0001", "001", "000", "1", { db, dataVersion: "v2" });
    expect([v1.tier, v1.estMonthlyCost]).toEqual([2, 10]);
    expect([v2.tier, v2.estMonthlyCost]).toEqual([3, 75]);
  });
});

// ---------------------------------------------------------------------------------------
// Real data: v1 = CMS Q2 2026, v2 = synthetic copy built by scripts/make-v2.ts
// ---------------------------------------------------------------------------------------
describe.skipIf(!fs.existsSync(dbPath()))("change tracker (real v1 vs synthetic v2)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
    const v2 = await db.query("SELECT 1 FROM data_versions WHERE data_version = 'v2'");
    if (v2.length === 0) throw new Error("No v2 in the database: run `npx tsx scripts/make-v2.ts` first");
  });
  afterAll(async () => {
    await db.close();
  });

  it("v2 is labeled synthetic and is a complete copy of v1", async () => {
    const [v] = await db.query<{ source: string }>("SELECT source FROM data_versions WHERE data_version = 'v2'");
    expect(v.source).toMatch(/^SYNTHETIC/);
    for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
      const [a] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE data_version = 'v1'`);
      const [b] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE data_version = 'v2'`);
      expect(b.n, table).toBe(a.n);
    }
  });

  it("v2 differs from v1 in exactly 6 formulary tiers and nothing else", async () => {
    expect(await diffFormularies(db)).toEqual([
      { formularyId: "00026191", rxcui: "1551300", oldTier: 3, newTier: 4 }, // Trulicity, Wellcare Classic
      { formularyId: "00026399", rxcui: "1100706", oldTier: 3, newTier: 4 }, // Tradjenta
      { formularyId: "00026399", rxcui: "1300803", oldTier: 3, newTier: 4 }, // Myrbetriq
      { formularyId: "00026399", rxcui: "2002420", oldTier: 3, newTier: 4 }, // Toujeo
      { formularyId: "00026399", rxcui: "2619154", oldTier: 3, newTier: 4 }, // Ozempic
      { formularyId: "00026399", rxcui: "314077", oldTier: 1, newTier: 2 }, // lisinopril 20 mg
    ]);
    const [other] = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM formulary a JOIN formulary b
         ON b.data_version = 'v2' AND b.formulary_id = a.formulary_id AND b.rxcui = a.rxcui
        WHERE a.data_version = 'v1'
          AND (a.ndc <> b.ndc OR a.quantity_limit <> b.quantity_limit OR a.prior_authorization <> b.prior_authorization
               OR a.step_therapy <> b.step_therapy OR a.quantity_limit_amount IS DISTINCT FROM b.quantity_limit_amount)`,
    );
    expect(other.n).toBe(0);
  });

  it("alerts the 7 seeded patients hit by those changes, biggest cost increase first", async () => {
    const alerts = await buildAlerts(db);
    expect(alerts.map((a) => [a.patientId, a.oldTier, a.newTier, a.oldMonthlyCost, a.newMonthlyCost])).toEqual([
      ["pt-006", 3, 4, 274.82, 373.75], // Toujeo
      ["pt-001", 3, 4, 264.97, 360.35], // Ozempic
      ["pt-003", 3, 4, 249.17, 299.01], // Trulicity
      ["pt-004", 3, 4, 126.14, 171.56], // Tradjenta
      ["pt-007", 3, 4, 110.49, 150.27], // Myrbetriq
      ["pt-006", 1, 2, 0, 1], // lisinopril 20 mg: one formulary change, two patients
      ["pt-002", 1, 2, 0, 1],
    ]);
    const lisinopril = alerts.filter((a) => a.drugName.startsWith("lisinopril"));
    expect(lisinopril.map((a) => a.patientName)).toEqual(["James Carter", "Robert Jenkins"]);
    expect(alerts[1].drugName).toContain("Ozempic");
    expect(alerts[1].patientName).toBe("Dorothy Washington");
  });

  it("does not alert patients whose drugs did not move, and leaves v1 answers untouched", async () => {
    const ids = new Set((await buildAlerts(db)).map((a) => a.patientId));
    for (const id of ["pt-005", "pt-008", "pt-009", "pt-010", "pt-011", "pt-012", "pt-013", "pt-014", "pt-015", "pt-016", "pt-017", "pt-018", "pt-019", "pt-020"]) {
      expect(ids.has(id), id).toBe(false);
    }
    const v1 = await checkCoverage("S5884", "135", "000", "2619154", { db });
    const v2 = await checkCoverage("S5884", "135", "000", "2619154", { db, dataVersion: "v2" });
    expect([v1.tier, v1.estMonthlyCost]).toEqual([3, 264.97]);
    expect([v2.tier, v2.estMonthlyCost]).toEqual([4, 360.35]);
  });
});
