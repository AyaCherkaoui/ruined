import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as queries from "./queries";
import { GET as listRoute } from "../app/api/alerts/route";
import { GET as getRoute } from "../app/api/alerts/[id]/route";
import { POST as resolveRoute } from "../app/api/alerts/[id]/resolve/route";
import { POST as demoResetRoute } from "../app/api/demo/reset/route";
import type { CoverageAlert, CoverageAlertChangeType } from "./contract";
import {
  buildCoverageAlert,
  createCoverageAlertStore,
  getAlert,
  listAlerts,
  normalizeChangeType,
  resetAlerts,
  resolveAlert,
  type CoverageChangeInput,
} from "./coverageAlerts";
import { getDb } from "./db";
import { DEMO_COVERAGE_CHANGES, loadDemoCoverageChanges } from "./demoCoverageAlerts";
import { ApiError } from "./http";

const PA_ID = "demo-eliquis-s5884-135-prior-auth-added";
const TIER_ID = "demo-eliquis-h5216-073-tier-increase";

// The demo reset route also resets the legacy patient_alerts table, so point it at a
// throwaway database instead of data/scenario.duckdb.
const TMP_DB = path.join(os.tmpdir(), `coverage-alerts-test-${process.pid}.duckdb`);

beforeAll(() => {
  process.env.RUINED_DB = TMP_DB;
});

afterAll(async () => {
  await (await getDb()).close();
  fs.rmSync(TMP_DB, { force: true });
  fs.rmSync(`${TMP_DB}.wal`, { force: true });
});

const CHANGE: CoverageChangeInput = {
  id: "chg-1",
  insurer: "Humana",
  planId: "S0000-001",
  planName: "Test Plan",
  drug: "Eliquis (apixaban) 5 mg tablet",
  rxcui: "1364447",
  changeType: "prior_auth_added",
  oldValue: "No prior authorization.",
  newValue: "Prior authorization required.",
  effectiveDate: null,
  detectedAt: "2026-09-26T00:00:00.000Z",
  source: "test",
  sourceUrl: null,
};

describe("demo data", () => {
  it("is Eliquis on two Humana plans, all labeled demo, with no patient estimate", async () => {
    const alerts = await listAlerts(createCoverageAlertStore(loadDemoCoverageChanges));
    expect(new Set(alerts.map((a) => a.planId)).size).toBe(2);
    for (const alert of alerts) {
      expect(alert).toMatchObject({ insurer: "Humana", isDemo: true, estimatedPatientRange: null, status: "open" });
      expect(alert.drug).toMatch(/Eliquis/);
      expect(alert.source).toMatch(/^DEMO/);
      expect(alert.actions.length).toBeGreaterThan(0);
    }
    expect(alerts.map((a) => a.changeType)).toContain("prior_auth_added");
  });

  it("the loader hands out a copy, so callers cannot change the demo list", async () => {
    (await loadDemoCoverageChanges()).pop();
    expect(await loadDemoCoverageChanges()).toHaveLength(DEMO_COVERAGE_CHANGES.length);
  });
});

describe("normalizeChangeType", () => {
  it("passes API names through and translates lib/pipeline names", () => {
    expect(normalizeChangeType("tier_decrease")).toBe("tier_decrease");
    expect(normalizeChangeType("new_prior_auth")).toBe("prior_auth_added");
    expect(normalizeChangeType("new_step_therapy")).toBe("step_therapy_added");
    expect(normalizeChangeType("new_quantity_limit")).toBe("quantity_limit_added");
    expect(normalizeChangeType("removed")).toBe("dropped");
    expect(normalizeChangeType("tier_increase")).toBe("tier_increase");
  });

  it("throws on an unknown name", () => {
    expect(() => normalizeChangeType("prior_auth")).toThrow(/Unknown coverage change type/);
  });
});

describe("buildCoverageAlert", () => {
  it("fills every CoverageAlert field, with defaults for the optional inputs", () => {
    const alert = buildCoverageAlert(CHANGE, null);
    expect(alert).toMatchObject({
      id: "chg-1",
      changeType: "prior_auth_added",
      summary: "Test Plan now requires prior authorization for Eliquis (apixaban) 5 mg tablet.",
      status: "open",
      resolvedAt: null,
      isDemo: false,
      estimatedPatientRange: null,
    });
    expect(Object.values(alert)).not.toContain(undefined);
    expect(alert.actions.map((a) => a.type)).toEqual(["find_affected_patients", "submit_prior_auth"]);
    expect(alert.actions[0].steps).toContain("Start with anyone whose next refill is soonest.");
  });

  it("is resolved when given a resolvedAt, and carries a patient range through", () => {
    const range = { min: 8, max: 12, basis: "CMS Part D prescriber data" };
    const alert = buildCoverageAlert({ ...CHANGE, estimatedPatientRange: range }, "2026-09-27T00:00:00.000Z");
    expect(alert).toMatchObject({ status: "resolved", resolvedAt: "2026-09-27T00:00:00.000Z", estimatedPatientRange: range });
  });

  it("gives every harmful change a summary and next steps, and helpful changes none", () => {
    const harmful: CoverageAlertChangeType[] = ["prior_auth_added", "step_therapy_added", "quantity_limit_added", "tier_increase", "dropped"];
    const helpful: CoverageAlertChangeType[] = ["prior_auth_removed", "step_therapy_removed", "quantity_limit_removed", "tier_decrease", "restored"];
    for (const changeType of [...harmful, ...helpful]) {
      const alert = buildCoverageAlert({ ...CHANGE, changeType }, null);
      expect(alert.summary).toMatch(/^Test Plan .+\.$/);
      expect(alert.actions.length > 0).toBe(harmful.includes(changeType));
    }
  });

  it("translates a pipeline change name", () => {
    expect(buildCoverageAlert({ ...CHANGE, changeType: "removed" }, null).changeType).toBe("dropped");
  });
});

describe("coverage alert service", () => {
  const T1 = new Date("2026-09-27T10:00:00.000Z");
  const T2 = new Date("2026-09-27T11:00:00.000Z");
  let clock = T1;
  let store = createCoverageAlertStore(loadDemoCoverageChanges, () => clock);

  beforeEach(() => {
    clock = T1;
    store = createCoverageAlertStore(loadDemoCoverageChanges, () => clock);
  });

  it("lists every alert, open", async () => {
    const alerts = await listAlerts(store);
    expect(alerts.map((a) => a.id).sort()).toEqual([PA_ID, TIER_ID].sort());
    expect(alerts.every((a) => a.status === "open" && a.resolvedAt === null)).toBe(true);
  });

  it("gets one alert by id", async () => {
    expect(await getAlert(PA_ID, store)).toMatchObject({ id: PA_ID, changeType: "prior_auth_added", planId: "S5884-135" });
  });

  it("throws a 404 ApiError for an unknown id, and a 400 for a blank one", async () => {
    await expect(getAlert("nope", store)).rejects.toMatchObject({ status: 404 });
    await expect(resolveAlert("nope", store)).rejects.toBeInstanceOf(ApiError);
    await expect(getAlert("  ", store)).rejects.toMatchObject({ status: 400 });
  });

  it("resolves an alert and the list reflects it", async () => {
    expect(await resolveAlert(PA_ID, store)).toMatchObject({ status: "resolved", resolvedAt: T1.toISOString() });
    const list = await listAlerts(store);
    expect(list.find((a) => a.id === PA_ID)?.status).toBe("resolved");
    expect(list.find((a) => a.id === TIER_ID)?.status).toBe("open");
  });

  it("resolving twice is safe and keeps the first resolvedAt", async () => {
    await resolveAlert(PA_ID, store);
    clock = T2;
    expect(await resolveAlert(PA_ID, store)).toMatchObject({ status: "resolved", resolvedAt: T1.toISOString() });
  });

  it("reset reopens every alert", async () => {
    await resolveAlert(PA_ID, store);
    await resolveAlert(TIER_ID, store);
    await resetAlerts(store);
    expect((await listAlerts(store)).every((a) => a.status === "open" && a.resolvedAt === null)).toBe(true);
  });

  it("never lets a caller mutate what the next request sees", async () => {
    const alert = await getAlert(PA_ID, store);
    alert.actions[0].steps.push("tampered");
    alert.summary = "tampered";
    const fresh = await getAlert(PA_ID, store);
    expect(fresh.summary).not.toBe("tampered");
    expect(fresh.actions[0].steps).not.toContain("tampered");
  });

  it("works with any loader, e.g. a pipeline one using pipeline names", async () => {
    const pipeline = createCoverageAlertStore(async () => [{ ...CHANGE, id: "p-1", changeType: "new_step_therapy" }]);
    expect(await getAlert("p-1", pipeline)).toMatchObject({ changeType: "step_therapy_added", isDemo: false });
    expect((await resolveAlert("p-1", pipeline)).status).toBe("resolved");
  });

  it("rejects a loader that returns duplicate ids", async () => {
    const dupes = createCoverageAlertStore(async () => [CHANGE, CHANGE]);
    await expect(listAlerts(dupes)).rejects.toThrow(/Duplicate coverage change id/);
  });
});

describe("API routes", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (body?: string) => new Request("http://localhost/", { method: "POST", body });

  beforeEach(async () => {
    await resetAlerts();
  });

  it("GET /api/alerts returns the list", async () => {
    const res = await listRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoverageAlert[];
    expect(body.map((a) => a.id).sort()).toEqual([PA_ID, TIER_ID].sort());
  });

  it("GET /api/alerts/:id returns one alert", async () => {
    const res = await getRoute(new Request("http://localhost/"), ctx(TIER_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: TIER_ID, changeType: "tier_increase", status: "open" });
  });

  it("GET /api/alerts/:id is 404 for an unknown id and 400 for a blank one", async () => {
    const missing = await getRoute(new Request("http://localhost/"), ctx("does-not-exist"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Alert does-not-exist not found" });
    const blank = await getRoute(new Request("http://localhost/"), ctx(" "));
    expect(blank.status).toBe(400);
  });

  it("POST /api/alerts/:id/resolve resolves, is idempotent, and 404s on unknown ids", async () => {
    const first = await resolveRoute(post(), ctx(PA_ID));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as CoverageAlert;
    expect(firstBody.status).toBe("resolved");

    const second = await resolveRoute(post(), ctx(PA_ID));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);

    const missing = await resolveRoute(post(), ctx("does-not-exist"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Alert does-not-exist not found" });
  });

  it("POST /api/alerts/:id/resolve ignores a malformed body", async () => {
    const res = await resolveRoute(post("{not json"), ctx(PA_ID));
    expect(res.status).toBe(200);
    expect(((await res.json()) as CoverageAlert).status).toBe("resolved");
  });

  it("an unknown COVERAGE_ALERTS_SOURCE is a 500 with an error body, not a crash", async () => {
    const g = globalThis as unknown as { __coverageAlertStore?: unknown };
    const saved = g.__coverageAlertStore;
    g.__coverageAlertStore = undefined;
    process.env.COVERAGE_ALERTS_SOURCE = "bogus";
    try {
      const res = await listRoute();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Unknown COVERAGE_ALERTS_SOURCE "bogus". Supported: demo, aggregate, supabase' });
    } finally {
      delete process.env.COVERAGE_ALERTS_SOURCE;
      g.__coverageAlertStore = saved;
    }
  });

  it("POST /api/demo/reset reopens coverage alerts and still resets legacy patient alerts", async () => {
    await resolveRoute(post(), ctx(PA_ID));
    const db = await getDb();
    await db.run(
      `INSERT INTO patient_alerts (id, change_id, patient_id, prescription_id, contract_id, plan_id, status, created_at)
       VALUES ('legacy-1', 'chg-1', 'pt-001', 'rx-001', 'H0001', '001', 'dismissed', CURRENT_TIMESTAMP)`,
    );

    const res = await demoResetRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });

    const alert = (await (await getRoute(new Request("http://localhost/"), ctx(PA_ID))).json()) as CoverageAlert;
    expect(alert).toMatchObject({ status: "open", resolvedAt: null });
    const legacy = await db.query<{ status: string }>("SELECT status FROM patient_alerts WHERE id = 'legacy-1'");
    expect(legacy[0].status).toBe("new");
  });

  it("preserves resolved coverage alerts when the legacy reset fails", async () => {
    await resolveRoute(post(), ctx(PA_ID));
    const reset = vi.spyOn(queries, "resetAlertStatuses").mockRejectedValue(new ApiError(503, "Demo database unavailable"));
    try {
      expect((await demoResetRoute()).status).toBe(503);
      expect(await (await getRoute(new Request("http://localhost/"), ctx(PA_ID))).json()).toMatchObject({ status: "resolved" });
    } finally { reset.mockRestore(); }
  });
});
