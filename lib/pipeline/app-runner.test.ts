import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "../db";
import type { Db } from "../db";
import { addDoctor, addDrug, addPatient, addPlan, addPrescription, addTier, TEST_PLAN } from "../testing";
import { runAppPipeline } from "./app-runner";
import { POST } from "../../app/api/pipeline/run/route";
import { GET } from "../../app/api/changes/route";

let db: Db;
beforeEach(async () => {
  db = await database.openDb({ path: ":memory:" });
  vi.spyOn(database, "getDb").mockResolvedValue(db);
});
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });

async function seed() {
  await addPlan(db);
  await addDrug(db, { rxcui: "1653204", name: "Demo NovoLog", ingredient: "demo", classId: null, tier: 2, unit: 1 });
  await addTier(db, 2, 1, 10);
  for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
    await db.run(`INSERT INTO ${table} SELECT * REPLACE ('v2-cms' AS data_version) FROM ${table} WHERE data_version='v1'`);
  }
  await db.run("UPDATE formulary SET prior_authorization=true WHERE data_version='v2-cms'");
  await addDoctor(db, "doc", "Demo Doctor");
  await addPatient(db, "pt", "Demo Patient", TEST_PLAN);
  await addPrescription(db, "rx", "pt", "doc", "1653204");
}

it("rejects unbootstrapped releases before manufacturing changes", async () => {
  const result = await POST();
  expect(result.status).toBe(503);
  expect(await db.query("SELECT * FROM coverage_changes")).toEqual([]);
});

it("runs the API three times with stable IDs, preserves review decisions, and lists persisted facts", async () => {
  await seed();
  const first = await POST();
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ changes: 1, alerts: 1 });
  await db.run("UPDATE patient_alerts SET status='dismissed'");
  for (let pass = 0; pass < 2; pass++) expect(await (await POST()).json()).toEqual(body);
  expect(await db.query("SELECT status FROM patient_alerts")).toEqual([{ status: "dismissed" }]);
  const changes = await GET();
  expect(changes.status).toBe(200);
  expect(await changes.json()).toMatchObject([{ id: body.changeIds[0], drugName: "Demo NovoLog", changeType: "new_prior_auth" }]);
});

it("rejects a second overlapping run and releases its guard after failure", async () => {
  const first = runAppPipeline(db);
  await expect(runAppPipeline(db)).rejects.toMatchObject({ status: 409 });
  await expect(first).rejects.toMatchObject({ status: 503 });
  await seed();
  await expect(runAppPipeline(db)).resolves.toMatchObject({ alerts: 1 });
});

it("rejects missing patient plan mappings", async () => {
  await seed();
  await db.run("UPDATE patient_coverage SET plan_id='missing'");
  expect((await POST()).status).toBe(503);
  expect(await db.query("SELECT * FROM coverage_changes")).toEqual([]);
});

it("does not mistake a missing entire formulary for a drug removal", async () => {
  await seed();
  await db.run("UPDATE plans SET formulary_id='missing' WHERE data_version='v2-cms'");
  expect((await POST()).status).toBe(503);
  expect(await db.query("SELECT * FROM coverage_changes")).toEqual([]);
});

it("rejects a missing baseline drug even when the other release tables are populated", async () => {
  await seed();
  await addDrug(db, { rxcui: "999", name: "Other", ingredient: "other", tier: 2, unit: 1 });
  await db.run("DELETE FROM formulary WHERE data_version='v1' AND rxcui='1653204'");
  await expect(runAppPipeline(db)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("baseline") });
  expect(await db.query("SELECT * FROM coverage_changes")).toEqual([]);
});

it("rolls back detected changes on an alert-write failure and permits a clean retry", async () => {
  await seed();
  const failing: Db = {
    query: db.query.bind(db), run: db.run.bind(db), close: db.close.bind(db),
    transaction: (work) => db.transaction!((tx) => work({
      query: tx.query.bind(tx), close: tx.close.bind(tx),
      run: async (sql, params) => {
        if (sql.includes("INSERT INTO patient_alerts")) throw new Error("Injected alert-write failure");
        await tx.run(sql, params);
      },
    })),
  };
  await expect(runAppPipeline(failing)).rejects.toThrow("Injected");
  expect(await db.query("SELECT * FROM coverage_changes")).toEqual([]);
  expect(await db.query("SELECT * FROM patient_alerts")).toEqual([]);
  await expect(runAppPipeline(db)).resolves.toMatchObject({ changes: 1, alerts: 1 });
});
