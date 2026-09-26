import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { setAlertStatus } from "./alertStatus";
import { alertId } from "./patientAlerts";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";
import { openDb, type Db } from "./db";

const CMS_TO = { key: "cms" as const, toVersion: "v2-cms", dataSource: "cms" as const, effectiveDate: "2026-09-01" };

// Four patients, one changed drug each: A (new, +$20, no alt), B (seen, +$50, $50 alt),
// C (dismissed, removed -- must disappear from the digest entirely), D (switched, PA-only, +$0).
describe("buildDigest", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db);
    await addTier(db, 1, 1, 0);
    await addTier(db, 2, 1, 20);
    await addTier(db, 3, 1, 50);

    await addDrug(db, { rxcui: "a", name: "drugA 10 MG Oral Tablet", ingredient: "Ia", classId: null, tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "b", name: "drugB 10 MG Oral Tablet", ingredient: "Ib", tier: 1, unit: 3 }); // default class C10AA; unit=3 so the $50 copay isn't capped by drug cost (30 x $3 = $90)
    await addDrug(db, { rxcui: "balt", name: "drugBalt 10 MG Oral Tablet", ingredient: "Ibalt", tier: 1, unit: 1 }); // same class as b
    await addDrug(db, { rxcui: "c", name: "drugC 10 MG Oral Tablet", ingredient: "Ic", classId: null, tier: 2, unit: 1 });
    await addDrug(db, { rxcui: "d", name: "drugD 10 MG Oral Tablet", ingredient: "Id", classId: null, tier: 1, unit: 1 });

    await addPatient(db, { id: "pA", name: "Ann" }, TEST_PLAN, [["a", "drugA"]]);
    await addPatient(db, { id: "pB", name: "Bea" }, TEST_PLAN, [["b", "drugB"]]);
    await addPatient(db, { id: "pC", name: "Cid" }, TEST_PLAN, [["c", "drugC"]]);
    await addPatient(db, { id: "pD", name: "Deb" }, TEST_PLAN, [["d", "drugD"]]);

    for (const t of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
      await db.run(`INSERT INTO ${t} SELECT * REPLACE ('v2-cms' AS data_version) FROM ${t} WHERE data_version = 'v1'`);
    }
    await db.run("UPDATE formulary SET tier = 2 WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = 'a'"); // +$20
    await db.run("UPDATE formulary SET tier = 3 WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = 'b'"); // +$50 ('balt' stays tier 1 = $0 alternative)
    await db.run("DELETE FROM formulary WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = 'c'"); // removed
    await db.run("UPDATE formulary SET prior_authorization = true WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = 'd'"); // +$0

    await setAlertStatus(alertId("pB", "b", "tier_increase"), "seen", null, db);
    await setAlertStatus(alertId("pC", "c", "removed"), "dismissed", null, db);
    await setAlertStatus(alertId("pD", "d", "new_prior_auth"), "switched", "some-other-rxcui", db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("excludes dismissed alerts entirely", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(digest.alerts).toHaveLength(3);
    expect(digest.alerts.map((a) => a.patientId)).not.toContain("pC");
  });

  it("totalAtRisk counts only new/seen, not switched or dismissed", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(digest.totalAtRisk).toBe(2); // pA (new) + pB (seen); pD is switched, pC is dismissed/hidden
  });

  it("totalMonthlyIncrease sums increases across shown (non-dismissed) alerts, treating null as 0", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(digest.totalMonthlyIncrease).toBe(70); // pA +$20, pB +$50, pD +$0 (dismissed pC's removal excluded)
  });

  it("totalMonthlySavingsIfSwitched sums bestAlternative.monthlySavings, 0 where there is none", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(digest.totalMonthlySavingsIfSwitched).toBe(50); // only pB has an alternative (drugBalt, $0)
  });

  it("sorts alerts by monthlyIncrease desc and carries status/switchedTo through", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(digest.alerts.map((a) => [a.patientId, a.monthlyIncrease, a.status, a.switchedTo])).toEqual([
      ["pB", 50, "seen", null],
      ["pA", 20, "new", null],
      ["pD", 0, "switched", "some-other-rxcui"],
    ]);
  });

  it("generatedAt is a fresh ISO timestamp", async () => {
    const digest = await buildDigest(db, CMS_TO);
    expect(() => new Date(digest.generatedAt).toISOString()).not.toThrow();
    expect(new Date(digest.generatedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("with nothing at all, the digest is all zeros", async () => {
    const empty = await openDb({ path: ":memory:" });
    await addPlan(empty);
    await addTier(empty, 1, 1, 0);
    await addDrug(empty, { rxcui: "z", name: "solodrug 10 MG Oral Tablet", ingredient: "Iz", tier: 1, unit: 1 });
    await addPatient(empty, { id: "pZ", name: "Zed" }, TEST_PLAN, [["z", "solodrug"]]);
    const digest = await buildDigest(empty, CMS_TO);
    expect(digest).toMatchObject({ totalAtRisk: 0, totalMonthlyIncrease: 0, totalMonthlySavingsIfSwitched: 0, alerts: [] });
    await empty.close();
  });
});
