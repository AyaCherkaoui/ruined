import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "../db";
import type { Db } from "../db";
import { addDoctor, addDrug, addPatient, addPlan, addPrescription, addTier } from "../testing";
import { runAppPipeline } from "./app-runner";
import { notifyPolicyChanges, policyDeliveryStatus } from "./policy-notification";
import { POST } from "../../app/api/demo/policy/route";
import { policyChangeLabel, policySentence } from "../medishift-view";
import { alertsForDoctor } from "../queries";

let db: Db;
const env = { SMS_MODE: "live", MESSAGING_CHANNEL: "whatsapp", TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "test-secret", TWILIO_WHATSAPP_FROM: "+15555550101", DOCTOR_PHONE: "+15555550102", SMS_SEND_TOKEN: "test-key", APP_URL: "https://demo.example.org" };
beforeEach(async () => {
  db = await database.openDb({ path: ":memory:" });
  vi.spyOn(database, "getDb").mockResolvedValue(db);
  await addPlan(db);
  await addDrug(db, { rxcui: "111", name: "Demo A", ingredient: "a", classId: null, tier: 1, unit: 1 });
  await addDrug(db, { rxcui: "222", name: "Demo B", ingredient: "b", classId: null, tier: 1, unit: 1 });
  await addTier(db, 1, 1, 10);
  await addTier(db, 2, 1, 30);
  for (const table of ["plans", "formulary", "beneficiary_cost", "pricing"]) {
    await db.run(`INSERT INTO ${table} SELECT * REPLACE ('v2-cms' AS data_version) FROM ${table} WHERE data_version='v1'`);
  }
  await addDoctor(db, "doc-001", "Demo Doctor");
  for (let i = 0; i < 12; i++) {
    await addPatient(db, `p${i}`, `Synthetic Patient ${i}`);
    await addPrescription(db, `rx${i}`, `p${i}`, "doc-001", i % 2 ? "111" : "222");
  }
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.close(); });

async function changePolicy() {
  await db.run("DELETE FROM formulary WHERE data_version='v2-cms' AND rxcui='222'");
  await db.run("UPDATE formulary SET tier=2, prior_authorization=true, step_therapy=true, quantity_limit=true WHERE data_version='v2-cms' AND rxcui='111'");
  return runAppPipeline(db);
}

it("runs unchanged -> all five adverse change types -> patient matches -> WhatsApp preview without sending", async () => {
  expect(await runAppPipeline(db)).toMatchObject({ changes: 0, alerts: 0, rxcuis: ["111", "222"] });
  expect((await notifyPolicyChanges(true, db, env)).patients).toBe(0);
  const run = await changePolicy();
  expect(run).toMatchObject({ changes: 5, alerts: 30 });
  const request = vi.fn();
  const preview = await notifyPolicyChanges(true, db, env, request);
  expect(preview).toMatchObject({ patients: 12, changes: 5, notification: { status: "preview" } });
  expect(preview.notification.body).toContain("https://demo.example.org/");
  expect(preview.notification.body).not.toContain("Synthetic Patient");
  expect(request).not.toHaveBeenCalled();
  expect(await runAppPipeline(db)).toEqual(run);
  const restricted = (await alertsForDoctor("doc-001", db)).filter(a => a.changeType !== "removed");
  expect(policySentence(restricted.map(a => ({ ...a, newMonthlyCost: null })))).not.toContain("no longer covers");
  expect(policyChangeLabel("new_prior_auth")).toBe("Prior authorization added");
});

it("sends once, persists a receipt, and checks delivered status without another send", async () => {
  await changePolicy();
  const request = vi.fn().mockResolvedValue(Response.json({ sid: `SM${"b".repeat(32)}`, status: "queued" }));
  const sent = await notifyPolicyChanges(false, db, env, request);
  expect(sent.notification.status).toBe("accepted");
  const duplicate = await notifyPolicyChanges(false, db, env, request);
  expect(duplicate).toMatchObject({ duplicate: true, notification: sent.notification });
  expect(request).toHaveBeenCalledTimes(1);
  const form = request.mock.calls[0][1].body as URLSearchParams;
  expect(form.get("To")).toBe(`whatsapp:${env.DOCTOR_PHONE}`);
  request.mockResolvedValue(Response.json({ status: "delivered" }));
  expect(await policyDeliveryStatus(sent.receiptId!, db, env, request)).toMatchObject({ deliveryStatus: "delivered" });
  expect(request.mock.calls[1][1].method).toBeUndefined();
});

it("holds uncertain sends across repeat calls and allows definite rejection retry", async () => {
  await changePolicy();
  const request = vi.fn().mockResolvedValue(Response.json({ code: 63015 }, { status: 400 }));
  expect((await notifyPolicyChanges(false, db, env, request)).notification.status).toBe("failed");
  request.mockRejectedValue(new Error("timeout"));
  expect((await notifyPolicyChanges(false, db, env, request)).notification.status).toBe("unknown");
  expect((await notifyPolicyChanges(false, db, env, request)).notification.status).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(2);
});

it("prevents parallel duplicate sends and rejects local review URLs", async () => {
  await changePolicy();
  await expect(notifyPolicyChanges(false, db, { ...env, APP_URL: "http://localhost:3000" })).rejects.toMatchObject({ status: 503 });
  const request = vi.fn().mockResolvedValue(Response.json({ sid: `SM${"b".repeat(32)}`, status: "queued" }));
  await Promise.all([notifyPolicyChanges(false, db, env, request), notifyPolicyChanges(false, db, env, request)]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("API validates JSON and authorizes live actions before running or sending", async () => {
  vi.stubEnv("SMS_SEND_TOKEN", "secret");
  const req = (body: string) => new Request("http://localhost/api/demo/policy", { method: "POST", body });
  expect((await POST(req("{"))).status).toBe(400);
  expect((await POST(req('{"action":"other"}'))).status).toBe(400);
  expect((await POST(req('{"action":"send"}'))).status).toBe(401);
  expect((await POST(req('{"action":"status","receiptId":"missing"}'))).status).toBe(401);
  await changePolicy();
  const preview = await POST(req('{"action":"preview"}'));
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ patients: 12, notification: { status: "preview" } });
});
