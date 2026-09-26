import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  alertId,
  buildPatientAlerts,
  getPatientAlert,
  parseAlertId,
  resolveChangeSource,
} from "./patientAlerts";
import { dbPath, openDb, type Db } from "./db";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";

const CMS_TO = { key: "cms" as const, toVersion: "v2-cms", dataSource: "cms" as const, effectiveDate: "2026-09-01" };

describe("alertId / parseAlertId", () => {
  it("round-trips patientId/rxcui/changeType", () => {
    const id = alertId("pt-009", "2200650", "removed");
    expect(id).toBe("pt-009:2200650:removed");
    expect(parseAlertId(id)).toEqual({ patientId: "pt-009", rxcui: "2200650", changeType: "removed" });
  });

  it("returns null for malformed or unknown-changeType ids", () => {
    expect(parseAlertId("not-enough-parts")).toBeNull();
    expect(parseAlertId("pt-1:123:not_a_real_change_type")).toBeNull();
    expect(parseAlertId("")).toBeNull();
  });
});

describe("resolveChangeSource", () => {
  const original = process.env.CHANGE_SOURCE;
  afterEach(() => {
    if (original === undefined) delete process.env.CHANGE_SOURCE;
    else process.env.CHANGE_SOURCE = original;
  });

  it("defaults to cms/v2-cms when unset", () => {
    delete process.env.CHANGE_SOURCE;
    expect(resolveChangeSource()).toEqual({ key: "cms", toVersion: "v2-cms", dataSource: "cms", effectiveDate: "2026-09-01" });
  });

  it("switches to synthetic/v2 only when explicitly requested", () => {
    process.env.CHANGE_SOURCE = "synthetic";
    expect(resolveChangeSource()).toEqual({ key: "synthetic", toVersion: "v2", dataSource: "synthetic", effectiveDate: "2027-01-01" });
  });

  it("falls back to cms for any other value", () => {
    process.env.CHANGE_SOURCE = "garbage";
    expect(resolveChangeSource().key).toBe("cms");
  });
});

// ---------------------------------------------------------------------------------------
// Synthetic world, v1 -> v2-cms. Tiers: 1 = $0 copay, 2 = $10 copay, 3 = 25% coinsurance.
// One patient (p1, "Ann") on 10 drugs covering every ChangeType plus the cases that must NOT alert.
// ---------------------------------------------------------------------------------------
describe("buildPatientAlerts / getPatientAlert (synthetic)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
    await addPlan(db); // TEST_PLAN, formulary F1
    await addTier(db, 1, 1, 0);
    await addTier(db, 2, 1, 10);
    await addTier(db, 3, 2, 0.25);

    // tierupdrug + cheapalt share the (default) interchangeable class C10AA and dose form, so
    // tierupdrug gets a real bestAlternative computed under v2-cms.
    await addDrug(db, { rxcui: "1", name: "tierupdrug 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 10 });
    await addDrug(db, { rxcui: "10", name: "cheapalt 10 MG Oral Tablet", ingredient: "I10", tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "2", name: "removeddrug 10 MG Oral Tablet", ingredient: "I2", classId: null, tier: 1, unit: 5 });
    await addDrug(db, { rxcui: "3", name: "newpadrug 10 MG Oral Tablet", ingredient: "I3", classId: null, tier: 2, unit: 10 });
    await addDrug(db, { rxcui: "4", name: "newstdrug 10 MG Oral Tablet", ingredient: "I4", classId: null, tier: 2, unit: 10 });
    await addDrug(db, { rxcui: "5", name: "newqldrug 10 MG Oral Tablet", ingredient: "I5", classId: null, tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "6", name: "multidrug 10 MG Oral Tablet", ingredient: "I6", classId: null, tier: 1, unit: 10 });
    // "notcovereddrug" is only added to v1... actually not added to v1 formulary at all (see below);
    // it appears ONLY in v2-cms, so before.status is not_covered and it must not alert.
    await addDrug(db, { rxcui: "8", name: "unchangeddrug 10 MG Oral Tablet", ingredient: "I8", classId: null, tier: 1, unit: 1 });
    await addDrug(db, { rxcui: "9", name: "improveddrug 10 MG Oral Tablet", ingredient: "I9", classId: null, tier: 3, unit: 10 });

    await addPatient(db, { id: "p1", name: "Ann", age: 70, language: "English" }, TEST_PLAN, [
      ["1", "tierupdrug"],
      ["2", "removeddrug"],
      ["3", "newpadrug"],
      ["4", "newstdrug"],
      ["5", "newqldrug"],
      ["6", "multidrug"],
      ["7", "notcovereddrug"],
      ["8", "unchangeddrug"],
      ["9", "improveddrug"],
    ]);

    for (const t of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
      await db.run(`INSERT INTO ${t} SELECT * REPLACE ('v2-cms' AS data_version) FROM ${t} WHERE data_version = 'v1'`);
    }
    // tierupdrug: 1 -> 2 ($0 -> $10)
    await db.run("UPDATE formulary SET tier = 2 WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '1'");
    // removeddrug: gone entirely from v2-cms
    await db.run("DELETE FROM formulary WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '2'");
    // newpadrug / newstdrug / newqldrug: same tier, one restriction flag newly added
    await db.run("UPDATE formulary SET prior_authorization = true WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '3'");
    await db.run("UPDATE formulary SET step_therapy = true WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '4'");
    await db.run("UPDATE formulary SET quantity_limit = true WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '5'");
    // multidrug: BOTH a tier increase and a new PA at once -> two separate alerts
    await db.run("UPDATE formulary SET tier = 2, prior_authorization = true WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '6'");
    // notcovereddrug: newly appears in v2-cms only (never on the v1 formulary) -> not a "change"
    // to an existing patient, so it must not alert even though the patient "takes" it.
    await addDrug(db, { rxcui: "7", name: "notcovereddrug 10 MG Oral Tablet", ingredient: "I7", classId: null }); // cache only, no v1 formulary/pricing row
    await db.run(
      `INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug)
       VALUES ('v2-cms', 'F1', '7', 'NDC7', 1, false, false, false, false)`,
    );
    await db.run(
      `INSERT INTO pricing (data_version, contract_id, plan_id, segment_id, ndc, days_supply, unit_cost) VALUES ('v2-cms', $1, $2, $3, 'NDC7', 30, 1)`,
      [TEST_PLAN.contractId, TEST_PLAN.planId, TEST_PLAN.segmentId],
    );
    // improveddrug: 3 -> 1 (better, not an alert)
    await db.run("UPDATE formulary SET tier = 1 WHERE data_version = 'v2-cms' AND formulary_id = 'F1' AND rxcui = '9'");
    // unchangeddrug and cheapalt: left as-is (identical in both versions)
  });
  afterAll(async () => {
    await db.close();
  });

  it("detects exactly the 7 expected alerts and skips not-covered-before / unchanged / improved", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    expect(alerts.map((a) => [a.rxcui, a.changeType])).toEqual([
      ["6", "tier_increase"],
      ["6", "new_prior_auth"],
      ["1", "tier_increase"],
      ["3", "new_prior_auth"],
      ["5", "new_quantity_limit"],
      ["4", "new_step_therapy"],
      ["2", "removed"],
    ]);
  });

  it("computes tier/cost fields correctly for a tier increase and a removal", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    const tierup = alerts.find((a) => a.rxcui === "1")!;
    expect(tierup).toMatchObject({ oldTier: 1, newTier: 2, oldMonthlyCost: 0, newMonthlyCost: 10, monthlyIncrease: 10, dataSource: "cms", effectiveDate: "2026-09-01" });

    const removed = alerts.find((a) => a.rxcui === "2")!;
    expect(removed).toMatchObject({ oldTier: 1, newTier: null, oldMonthlyCost: 0, newMonthlyCost: null, monthlyIncrease: null, percentIncrease: null });
  });

  it("a restriction-only change (same tier) still alerts, with monthlyIncrease 0", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    const newpa = alerts.find((a) => a.rxcui === "3")!;
    expect(newpa).toMatchObject({ oldTier: 2, newTier: 2, oldMonthlyCost: 10, newMonthlyCost: 10, monthlyIncrease: 0 });
  });

  it("a drug with both a tier increase and a new restriction produces two alerts sharing the same before/after", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO).then((a) => a.filter((x) => x.rxcui === "6"));
    expect(alerts).toHaveLength(2);
    for (const a of alerts) expect(a).toMatchObject({ oldTier: 1, newTier: 2, oldMonthlyCost: 0, newMonthlyCost: 10 });
    expect(alerts.map((a) => a.changeType).sort()).toEqual(["new_prior_auth", "tier_increase"]);
    expect(alerts[0].id).not.toBe(alerts[1].id);
  });

  it("computes bestAlternative under the TO version (only for the drug with an interchangeable class)", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    const tierup = alerts.find((a) => a.rxcui === "1")!;
    expect(tierup.bestAlternative).toMatchObject({ rxcui: "10", estMonthlyCost: 0, monthlySavings: 10 });
    for (const a of alerts.filter((x) => x.rxcui !== "1")) expect(a.bestAlternative).toBeNull();
  });

  it("defaults every alert's status to new/null until acted on", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    for (const a of alerts) expect([a.status, a.switchedTo]).toEqual(["new", null]);
  });

  it("getPatientAlert fetches one alert by id and returns null for an id that doesn't match a real change", async () => {
    const found = await getPatientAlert(alertId("p1", "6", "new_prior_auth"), db, CMS_TO);
    expect(found).toMatchObject({ rxcui: "6", changeType: "new_prior_auth", oldTier: 1, newTier: 2 });

    expect(await getPatientAlert(alertId("p1", "6", "new_step_therapy"), db, CMS_TO)).toBeNull(); // multidrug never got step therapy
    expect(await getPatientAlert(alertId("p1", "8", "removed"), db, CMS_TO)).toBeNull(); // unchangeddrug never changed
    expect(await getPatientAlert(alertId("no-such-patient", "1", "tier_increase"), db, CMS_TO)).toBeNull();
    expect(await getPatientAlert("garbage", db, CMS_TO)).toBeNull();
  });

  it("with no v2-cms loaded, there is nothing to report", async () => {
    const empty = await openDb({ path: ":memory:" });
    await addPlan(empty);
    await addTier(empty, 1, 1, 0);
    await addDrug(empty, { rxcui: "1", name: "solodrug 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 1 });
    await addPatient(empty, { id: "p1", name: "Ann" }, TEST_PLAN, [["1", "solodrug"]]);
    expect(await buildPatientAlerts(empty, CMS_TO)).toEqual([]);
    await empty.close();
  });
});

// ---------------------------------------------------------------------------------------
// Real data: v1 = CMS Q2 2026 quarterly, v2-cms = CMS September 2026 monthly (task 1).
// ---------------------------------------------------------------------------------------
describe.skipIf(!fs.existsSync(dbPath()))("buildPatientAlerts (real v1 vs CMS v2-cms)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
    const v2cms = await db.query("SELECT 1 FROM data_versions WHERE data_version = 'v2-cms'");
    if (v2cms.length === 0) throw new Error("No v2-cms in the database: run scripts/load_puf_monthly.py first");
  });
  afterAll(async () => {
    await db.close();
  });

  it("finds the 4 real removals (Rybelsus dropped from every roster plan), all dataSource cms", async () => {
    const alerts = await buildPatientAlerts(db, CMS_TO);
    expect(alerts).toHaveLength(4);
    for (const a of alerts) {
      expect(a).toMatchObject({ rxcui: "2200650", changeType: "removed", dataSource: "cms", effectiveDate: "2026-09-01", newTier: null, newMonthlyCost: null, bestAlternative: null });
    }
    expect(alerts.map((a) => [a.patientId, a.oldMonthlyCost])).toEqual([
      ["pt-020", 188.9], // Anita Sharma
      ["pt-009", 238.41], // Carlos Ramirez
      ["pt-012", 47], // Fatima Ali
      ["pt-018", 182.28], // Tran Van Nguyen
    ]);
  });

  it("does not touch the other 16 patients", async () => {
    const ids = new Set((await buildPatientAlerts(db, CMS_TO)).map((a) => a.patientId));
    for (const id of ["pt-001", "pt-002", "pt-003", "pt-004", "pt-005", "pt-006", "pt-007", "pt-008", "pt-010", "pt-011", "pt-013", "pt-014", "pt-015", "pt-016", "pt-017", "pt-019"]) {
      expect(ids.has(id), id).toBe(false);
    }
  });
});
