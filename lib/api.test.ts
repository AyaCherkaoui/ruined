import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postCheck } from "../app/api/check/route";
import { GET as getDashboard } from "../app/api/dashboard/route";
import { GET as getPatientById } from "../app/api/patients/[id]/route";
import { GET as getPatients } from "../app/api/patients/route";
import type { CheckResponse, DashboardResponse, Patient } from "./contract";
import { dbPath, getDb } from "./db";

// The real route handlers, called directly, against a temp COPY of the database (so the tests never
// hold a write lock on the real file).

const original = dbPath();
const hasDb = fs.existsSync(original);
const tmp = path.join(os.tmpdir(), `ruined-api-test-${process.pid}.duckdb`);
const post = (body: string) => postCheck(new Request("http://x/api/check", { method: "POST", body }));

describe.skipIf(!hasDb)("API route handlers", () => {
  beforeAll(() => {
    fs.copyFileSync(original, tmp);
    process.env.RUINED_DB = tmp;
  });
  afterAll(async () => {
    await (await getDb()).close();
    delete (globalThis as { __ruinedDb?: unknown }).__ruinedDb;
    delete process.env.RUINED_DB;
    fs.rmSync(tmp, { force: true });
  });

  it("GET /api/patients -> 200, 20 Patients", async () => {
    const res = await getPatients();
    expect(res.status).toBe(200);
    const patients = (await res.json()) as Patient[];
    expect(patients).toHaveLength(20);
    expect(Object.keys(patients[0]).sort()).toEqual(["age", "id", "language", "meds", "name", "plan"]);
  });

  it("GET /api/patients/[id] -> the patient, or 404", async () => {
    const ok = await getPatientById(new Request("http://x"), { params: Promise.resolve({ id: "pt-004" }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Patient).name).toBe("Harold Bennett");
    const missing = await getPatientById(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Patient nope not found" });
  });

  it("POST /api/check -> CheckResponse (coverage + alternatives)", async () => {
    const res = await post(JSON.stringify({ patientId: "pt-004", rxcui: "1100706" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckResponse;
    expect(body.coverage).toMatchObject({ rxcui: "1100706", tier: 3, estMonthlyCost: 126.14, isEstimate: true });
    expect(body.alternatives[0]).toMatchObject({ estMonthlyCost: 29.31, monthlySavings: 96.83 });
  });

  it("POST /api/check maps errors to JSON with the right status", async () => {
    const cases: [string, number][] = [
      ["not json", 400],
      ["[1]", 400],
      ["{}", 400],
      [JSON.stringify({ patientId: "pt-001", rxcui: "abc" }), 400],
      [JSON.stringify({ patientId: "pt-999", rxcui: "617311" }), 404],
      [JSON.stringify({ contractId: "H9999", planId: "999", rxcui: "617311" }), 404],
    ];
    for (const [body, status] of cases) {
      const res = await post(body);
      expect(res.status, body).toBe(status);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
  });

  it("GET /api/dashboard -> DashboardResponse", async () => {
    const res = await getDashboard();
    expect(res.status).toBe(200);
    const d = (await res.json()) as DashboardResponse;
    expect(Object.keys(d).sort()).toEqual(["atRisk", "patientsOverpaying", "totalPatients", "totalPotentialMonthlySavings"]);
    expect(d.totalPatients).toBe(20);
    expect(d.patientsOverpaying).toBe(d.atRisk.length);
  });
});
