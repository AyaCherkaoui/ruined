import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "./db";
import type { Db } from "./db";
import { addDoctor, addDrug, addPatient, addPlan, addPrescription, addTier, TEST_PLAN } from "./testing";
import { runAppPipeline } from "./pipeline/app-runner";
import { alertById, resetAlertStatuses } from "./queries";
import { POST } from "../app/api/alerts/[id]/selection/route";

let db: Db, id: string;
beforeEach(async () => {
  db = await database.openDb({ path: ":memory:" });
  vi.spyOn(database, "getDb").mockResolvedValue(db);
  await addPlan(db);
  await addDrug(db, { rxcui: "1653204", name: "Demo Brand", ingredient: "demo", classId: null, generic: "123456", tier: 2, unit: 1 });
  await addDrug(db, { rxcui: "123456", name: "Demo Generic", ingredient: "demo", classId: null, tier: 1, unit: 1 });
  await addTier(db, 1, 1, 5);
  await addTier(db, 2, 1, 10);
  for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) await db.run(`INSERT INTO ${table} SELECT * REPLACE ('v2-cms' AS data_version) FROM ${table} WHERE data_version='v1'`);
  await db.run("UPDATE formulary SET prior_authorization=true WHERE data_version='v2-cms' AND rxcui='1653204'");
  await addDoctor(db, "doc", "Demo Doctor");
  await addPatient(db, "pt", "Demo Patient", TEST_PLAN);
  await addPrescription(db, "rx", "pt", "doc", "1653204");
  id = (await runAppPipeline(db)).alertIds[0];
});
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });
const request = (body: string) => new Request("http://localhost/api/alerts/selection", { method: "POST", body });
const ctx = (value = id) => ({ params: Promise.resolve({ id: value }) });

it("persists an eligible choice, marks reviewed, preserves the prescription, and resets repeatably", async () => {
  for (let pass = 0; pass < 3; pass++) {
    const response = await POST(request(JSON.stringify({ rxcui: "123456", estMonthlyCost: -999 })), ctx());
    expect(response.status).toBe(200);
    const alert = await response.json();
    expect(alert).toMatchObject({ status: "seen", selectedAlternative: { rxcui: "123456", drugName: "Demo Generic", estMonthlyCost: 5 } });
    expect(await alertById(id, db)).toEqual(alert);
    expect(await (await POST(request('{"rxcui":"123456"}'), ctx())).json()).toEqual(alert);
    expect(await db.query("SELECT rxcui FROM prescriptions")).toEqual([{ rxcui: "1653204" }]);
    await runAppPipeline(db);
    expect((await alertById(id, db))?.selectedAlternative).toEqual(alert.selectedAlternative);
    await resetAlertStatuses(db);
    expect(await alertById(id, db)).toMatchObject({ status: "new", selectedAlternative: null });
  }
});

it("rejects malformed, unknown, and no-longer-covered selections without saving a decision", async () => {
  expect((await POST(request("{"), ctx())).status).toBe(400);
  expect((await POST(request('{"rxcui":"123456"}'), ctx("missing"))).status).toBe(404);
  expect((await POST(request('{"rxcui":"999999"}'), ctx())).status).toBe(422);
  await db.run("DELETE FROM formulary WHERE data_version='v2-cms' AND rxcui='123456'");
  expect((await POST(request('{"rxcui":"123456"}'), ctx())).status).toBe(422);
  expect(await alertById(id, db)).toMatchObject({ status: "new", selectedAlternative: null });
});
