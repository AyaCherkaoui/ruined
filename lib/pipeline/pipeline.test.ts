import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPath, openDb, type Db } from "../db";
import { addDoctor, addDrug, addPatient, addPlan, addPrescription, addTier, TEST_FORMULARY, TEST_PLAN } from "../testing";
import { detectChanges } from "./detectChanges";
import { ingestRelease } from "./ingestRelease";
import { matchPrescriptions } from "./matchPrescriptions";

// Synthetic two-version world (v1 -> v2) so every number is under our control:
//   R1: tier 2 (copay $10) -> tier 3 (coinsurance 25%) AND newly requires prior auth
//   R2: tier 1, unchanged
//   R3: tier 3 -> removed from the formulary entirely
// pt-1 takes R1 (affected twice), pt-2 takes R2 (unaffected). Nobody takes R3.

const TMP = `${dbPath()}.pipeline-test.duckdb`;
let db: Db;

beforeAll(async () => {
  fs.rmSync(TMP, { force: true });
  db = await openDb({ path: TMP });

  await addPlan(db); // v1, TEST_PLAN, TEST_FORMULARY
  await addDrug(db, { rxcui: "R1", name: "Drug One", ingredient: "ing1", classId: null, tier: 2, unit: 10 });
  await addDrug(db, { rxcui: "R2", name: "Drug Two", ingredient: "ing2", classId: null, tier: 1, unit: 5 });
  await addDrug(db, { rxcui: "R3", name: "Drug Three", ingredient: "ing3", classId: null, tier: 3, unit: 20 });
  await addTier(db, 1, 1, 5);
  await addTier(db, 2, 1, 10);
  await addTier(db, 3, 2, 0.25);

  await db.run(
    `INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id, snp)
     SELECT 'v2', contract_id, plan_id, segment_id, plan_name, formulary_id, snp FROM plans WHERE data_version = 'v1'`,
  );
  await db.run(
    `INSERT INTO beneficiary_cost SELECT 'v2', contract_id, plan_id, segment_id, coverage_level, tier, days_supply,
        cost_type_pref, cost_amt_pref, cost_min_amt_pref, cost_max_amt_pref,
        cost_type_nonpref, cost_amt_nonpref, cost_min_amt_nonpref, cost_max_amt_nonpref,
        cost_type_mail_pref, cost_amt_mail_pref, cost_min_amt_mail_pref, cost_max_amt_mail_pref,
        cost_type_mail_nonpref, cost_amt_mail_nonpref, cost_min_amt_mail_nonpref, cost_max_amt_mail_nonpref,
        tier_specialty, ded_applies
     FROM beneficiary_cost WHERE data_version = 'v1'`,
  );
  await db.run(`INSERT INTO pricing SELECT 'v2', contract_id, plan_id, segment_id, ndc, days_supply, unit_cost FROM pricing WHERE data_version = 'v1'`);
  // v2 formulary: R1 tier 2->3 AND new PA; R2 unchanged; R3 simply absent (removed).
  await db.run(
    `INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug)
     VALUES ('v2', $1, 'R1', 'NDCR1', 3, false, true, false, false)`,
    [TEST_FORMULARY],
  );
  await db.run(
    `INSERT INTO formulary (data_version, formulary_id, rxcui, ndc, tier, quantity_limit, prior_authorization, step_therapy, selected_drug)
     VALUES ('v2', $1, 'R2', 'NDCR2', 1, false, false, false, false)`,
    [TEST_FORMULARY],
  );

  await addDoctor(db, "doc-1", "Dr. Test");
  await addPatient(db, "pt-1", "Patient One", TEST_PLAN);
  await addPrescription(db, "rx-1", "pt-1", "doc-1", "R1");
  await addPatient(db, "pt-2", "Patient Two", TEST_PLAN);
  await addPrescription(db, "rx-2", "pt-2", "doc-1", "R2");
});

afterAll(async () => {
  await db.close();
  fs.rmSync(TMP, { force: true });
});

describe("ingestRelease", () => {
  it("inserts a new data_version row", async () => {
    const row = await ingestRelease({ dataVersion: "vX", source: "test source", releaseDate: "2026-01-01", filePath: "x.zip", fileHash: "abc" }, db);
    expect(row).toMatchObject({ id: "vX", source: "test source", fileHash: "abc" });
  });

  it("is a no-op when the file hash matches an existing row", async () => {
    const first = await ingestRelease({ dataVersion: "vY", source: "s1", releaseDate: "2026-01-01", filePath: "y.zip", fileHash: "hash1" }, db);
    const second = await ingestRelease({ dataVersion: "vY", source: "s1", releaseDate: "2026-01-01", filePath: "y.zip", fileHash: "hash1" }, db);
    expect(second.loadedAt).toEqual(first.loadedAt);
  });

  it("replaces the row's metadata when the hash changes under the same id", async () => {
    await ingestRelease({ dataVersion: "vZ", source: "s1", releaseDate: "2026-01-01", filePath: "z.zip", fileHash: "old" }, db);
    const updated = await ingestRelease({ dataVersion: "vZ", source: "s2", releaseDate: "2026-02-01", filePath: "z2.zip", fileHash: "new" }, db);
    expect(updated).toMatchObject({ source: "s2", fileHash: "new" });
  });

  it("treats a null hash as always matching an existing row by id (idempotent, but can't detect a same-id content swap)", async () => {
    const first = await ingestRelease({ dataVersion: "vNull", source: "original", releaseDate: "2026-01-01", filePath: "n.zip", fileHash: null }, db);
    const second = await ingestRelease({ dataVersion: "vNull", source: "changed", releaseDate: "2026-01-01", filePath: "n.zip", fileHash: null }, db);
    expect(second).toEqual(first);
  });
});

describe("detectChanges", () => {
  it("detects a tier increase and a new prior auth as two separate rows for the same drug", async () => {
    const changes = await detectChanges("v1", "v2", ["R1"], db);
    expect(changes.map((c) => c.changeType).sort()).toEqual(["new_prior_auth", "tier_increase"]);
    for (const c of changes) expect(c).toMatchObject({ rxcui: "R1", formularyId: TEST_FORMULARY, oldTier: 2, newTier: 3 });
  });

  it("detects a removed drug (no new_tier)", async () => {
    const changes = await detectChanges("v1", "v2", ["R3"], db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: "removed", oldTier: 3, newTier: null });
  });

  it("does not record an unchanged drug", async () => {
    expect(await detectChanges("v1", "v2", ["R2"], db)).toEqual([]);
  });

  it("is idempotent: rerunning returns the same rows and does not duplicate storage", async () => {
    const first = await detectChanges("v1", "v2", ["R1"], db);
    const second = await detectChanges("v1", "v2", ["R1"], db);
    expect(second.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    const rows = await db.query<{ c: number }>("SELECT count(*) c FROM coverage_changes WHERE rxcui = 'R1'");
    expect(Number(rows[0].c)).toBe(2);
  });
});

describe("matchPrescriptions", () => {
  it("matches the patient on the affected drug, with cost before/after from checkCoverage and no alternative", async () => {
    const changes = await detectChanges("v1", "v2", ["R1"], db);
    const alerts = await matchPrescriptions(changes.map((c) => c.id), db);
    expect(alerts).toHaveLength(2); // tier_increase + new_prior_auth, same prescription
    for (const a of alerts) {
      expect(a.patientId).toBe("pt-1");
      expect(a.prescriptionId).toBe("rx-1");
      expect(a.oldMonthlyCost).toBeCloseTo(10); // tier 2 copay $10 flat, drug cost $10 x 30 = $300 -> capped at $10
      expect(a.newMonthlyCost).toBeCloseTo(75); // tier 3 coinsurance 25% x ($10 x 30) = $75
      expect(a.bestAlternativeRxcui).toBeNull(); // no classId, no generic -- nothing to switch to
      expect(a.status).toBe("new");
    }
  });

  it("does not alert the patient whose drug did not change", async () => {
    const changes = await detectChanges("v1", "v2", ["R2"], db);
    expect(await matchPrescriptions(changes.map((c) => c.id), db)).toEqual([]);
  });

  it("is idempotent: rerunning does not duplicate patient_alerts rows", async () => {
    const changes = await detectChanges("v1", "v2", ["R1"], db);
    const first = await matchPrescriptions(changes.map((c) => c.id), db);
    const second = await matchPrescriptions(changes.map((c) => c.id), db);
    expect(second.map((a) => a.id).sort()).toEqual(first.map((a) => a.id).sort());
    const rows = await db.query<{ c: number }>("SELECT count(*) c FROM patient_alerts");
    expect(Number(rows[0].c)).toBe(first.length);
  });

  it("returns nothing for an empty changeIds list", async () => {
    expect(await matchPrescriptions([], db)).toEqual([]);
  });
});
