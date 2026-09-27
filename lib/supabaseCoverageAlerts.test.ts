import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoverageAlert } from "./contract";

// Supabase-mode tests with a small in-memory fake of the supabase-js query builder, so the
// sign-in -> store -> route path runs without a live project.

const auth = vi.hoisted(() => ({ configured: true, client: null as unknown }));

vi.mock("./supabase/server", () => ({
  supabaseConfigured: () => auth.configured,
  supabaseEnv: () => (auth.configured ? { url: "http://supabase.test", key: "sb_publishable_test" } : null),
  createSupabaseServerClient: async () => auth.client,
}));

import { GET as listRoute } from "../app/api/alerts/route";
import { GET as getRoute } from "../app/api/alerts/[id]/route";
import { POST as resolveRoute } from "../app/api/alerts/[id]/resolve/route";
import { POST as resetRoute } from "../app/api/demo/reset/route";
import { POST as pipelineRoute } from "../app/api/pipeline/run/route";
import { POST as selectionRoute } from "../app/api/alerts/[id]/selection/route";
import { GET as changesRoute } from "../app/api/changes/route";
import * as queries from "./queries";
import { requireUser, safeNextPath } from "./auth";
import { resetAlerts } from "./coverageAlerts";
import { DEMO_COVERAGE_CHANGES } from "./demoCoverageAlerts";
import { changeInputToRow, rowToChangeInput, type CoverageAlertRow } from "./supabaseCoverageAlerts";

type Row = Record<string, unknown>;
interface FakeDb {
  coverage_alerts: Row[];
  coverage_alert_resolutions: Row[];
}

function fakeSupabase(db: FakeDb, userId: string | null, missingTables = false) {
  function builder(table: keyof FakeDb) {
    const filters: [string, unknown][] = [];
    let op: "select" | "delete" = "select";
    const matches = (row: Row) => filters.every(([col, val]) => row[col] === val);
    const error = missingTables ? { code: "PGRST205", message: "Could not find the table" } : null;
    const run = () => {
      if (error) return { data: null, error };
      if (op === "delete") {
        db[table] = db[table].filter((row) => !matches(row));
        return { data: null, error: null };
      }
      return { data: db[table].filter(matches).map((row) => ({ ...row })), error: null };
    };
    const b = {
      select: () => b,
      delete: () => ((op = "delete"), b),
      eq: (col: string, val: unknown) => (filters.push([col, val]), b),
      maybeSingle: async () => {
        const { data, error } = run();
        return { data: data?.[0] ?? null, error };
      },
      upsert: async (row: Row, opts: { ignoreDuplicates?: boolean }) => {
        if (error) return { error };
        const exists = db[table].some((r) => r.user_id === row.user_id && r.alert_id === row.alert_id);
        if (!exists) db[table].push({ ...row, resolved_at: new Date().toISOString() });
        else if (!opts.ignoreDuplicates) throw new Error("fake only supports ignoreDuplicates");
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  }
  return {
    from: (table: keyof FakeDb) => builder(table),
    auth: {
      getUser: async () =>
        userId
          ? { data: { user: { id: userId, email: `${userId}@clinic.test` } }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing!" } },
    },
  };
}

function seededDb(): FakeDb {
  return { coverage_alerts: DEMO_COVERAGE_CHANGES.map((c) => ({ ...changeInputToRow(c) })), coverage_alert_resolutions: [] };
}

const PA_ID = "demo-eliquis-s5884-135-prior-auth-added";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = () => new Request("http://localhost/", { method: "POST" });

let db: FakeDb;
beforeEach(() => {
  auth.configured = true;
  db = seededDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COVERAGE_ALERTS_SOURCE;
});

describe("auth", () => {
  it("is off when Supabase is not configured", async () => {
    auth.configured = false;
    expect(await requireUser()).toBeNull();
  });

  it("rejects a signed-out request with a 401 ApiError", async () => {
    auth.client = fakeSupabase(db, null);
    await expect(requireUser()).rejects.toMatchObject({ status: 401, message: "Sign in required" });
  });

  it("returns the verified user", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    expect((await requireUser())?.user).toEqual({ id: "doc-a", email: "doc-a@clinic.test" });
  });

  it("safeNextPath only allows same-site paths", () => {
    expect(safeNextPath("/coverage-alerts?x=1")).toBe("/coverage-alerts?x=1");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "", undefined, 42]) expect(safeNextPath(bad)).toBe("/");
  });
});

describe("coverage alert routes with Supabase", () => {
  it("401 for every alert route when signed out", async () => {
    auth.client = fakeSupabase(db, null);
    expect((await listRoute()).status).toBe(401);
    expect((await getRoute(new Request("http://localhost/"), ctx(PA_ID))).status).toBe(401);
    const res = await resolveRoute(post(), ctx(PA_ID));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in required" });
    expect(db.coverage_alert_resolutions).toHaveLength(0);
  });

  it("401 even when the demo store is forced, so sign-in cannot be skipped", async () => {
    process.env.COVERAGE_ALERTS_SOURCE = "demo";
    auth.client = fakeSupabase(db, null);
    expect((await listRoute()).status).toBe(401);
  });

  it("also protects aggregate mode and the restored demo API endpoints", async () => {
    process.env.COVERAGE_ALERTS_SOURCE = "aggregate";
    auth.client = fakeSupabase(db, null);
    expect((await listRoute()).status).toBe(401);
    expect((await resetRoute()).status).toBe(401);
    expect((await pipelineRoute()).status).toBe(401);
    expect((await changesRoute()).status).toBe(401);
    expect((await selectionRoute(post(), ctx(PA_ID))).status).toBe(401);
  });

  it("the reset endpoint uses the signed-in doctor's Supabase store", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    db.coverage_alert_resolutions.push(
      { user_id: "doc-a", alert_id: PA_ID, resolved_at: "2026-09-27T00:00:00Z" },
      { user_id: "doc-b", alert_id: PA_ID, resolved_at: "2026-09-27T00:00:00Z" },
    );
    vi.spyOn(queries, "resetAlertStatuses").mockResolvedValue({ reset: true });
    expect((await resetRoute()).status).toBe(200);
    expect(db.coverage_alert_resolutions).toHaveLength(1);
    expect(db.coverage_alert_resolutions[0].user_id).toBe("doc-b");
  });

  it("a source reversal stays resolved after the doctor's manual reset", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    db.coverage_alerts.find((row) => row.id === PA_ID)!.source_resolved_at = "2026-09-29T00:00:00Z";
    await resetAlerts();
    expect(await (await getRoute(post(), ctx(PA_ID))).json()).toMatchObject({ status: "resolved", resolvedAt: "2026-09-29T00:00:00.000Z" });
  });

  it("lists alerts from the database with the same CoverageAlert shape", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    const res = await listRoute();
    expect(res.status).toBe(200);
    const alerts = (await res.json()) as CoverageAlert[];
    expect(alerts.map((a) => a.id).sort()).toEqual(DEMO_COVERAGE_CHANGES.map((c) => c.id).sort());
    const pa = alerts.find((a) => a.id === PA_ID)!;
    expect(pa).toMatchObject({ status: "open", resolvedAt: null, isDemo: true, detectedAt: "2026-09-26T13:00:00.000Z" });
    expect(pa.actions.map((a) => a.type)).toEqual(["find_affected_patients", "submit_prior_auth"]);
  });

  it("404 for an unknown alert, for get and resolve", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    expect((await getRoute(new Request("http://localhost/"), ctx("nope"))).status).toBe(404);
    expect((await resolveRoute(post(), ctx("nope"))).status).toBe(404);
    expect(db.coverage_alert_resolutions).toHaveLength(0);
  });

  it("resolve is per doctor and idempotent", async () => {
    auth.client = fakeSupabase(db, "doc-a");
    const first = (await (await resolveRoute(post(), ctx(PA_ID))).json()) as CoverageAlert;
    expect(first.status).toBe("resolved");
    const second = await resolveRoute(post(), ctx(PA_ID));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
    expect(db.coverage_alert_resolutions).toHaveLength(1);

    auth.client = fakeSupabase(db, "doc-b");
    const other = (await (await getRoute(new Request("http://localhost/"), ctx(PA_ID))).json()) as CoverageAlert;
    expect(other.status).toBe("open");
  });

  it("demo reset reopens only the signed-in doctor's alerts", async () => {
    db.coverage_alert_resolutions.push(
      { user_id: "doc-a", alert_id: PA_ID, resolved_at: "2026-09-27T00:00:00Z" },
      { user_id: "doc-b", alert_id: PA_ID, resolved_at: "2026-09-27T00:00:00Z" },
    );
    auth.client = fakeSupabase(db, "doc-a");
    // What POST /api/demo/reset runs first. Its legacy DuckDB half is covered in coverageAlerts.test.ts.
    await resetAlerts();
    expect(db.coverage_alert_resolutions.map((r) => r.user_id)).toEqual(["doc-b"]);
  });

  it("503 with setup instructions when the tables were never created", async () => {
    auth.client = fakeSupabase(db, "doc-a", true);
    const res = await listRoute();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Run supabase\/migrations/);
  });
});

describe("row mapping (Person 3's insert path)", () => {
  it("round-trips every demo change", () => {
    for (const change of DEMO_COVERAGE_CHANGES) {
      expect(rowToChangeInput(changeInputToRow(change))).toEqual({ ...change, estimatedPatientRange: null });
    }
  });

  it("translates pipeline change names and carries a patient range", () => {
    const row = changeInputToRow({
      ...DEMO_COVERAGE_CHANGES[0],
      changeType: "prior_authorization_added",
      estimatedPatientRange: { min: 8, max: 12, basis: "CMS Part D prescriber data" },
    });
    expect(row).toMatchObject({ change_type: "prior_auth_added", estimated_patients_min: 8, estimated_patients_max: 12, is_demo: true });
    expect(rowToChangeInput(row).estimatedPatientRange).toEqual({ min: 8, max: 12, basis: "CMS Part D prescriber data" });
    expect(changeInputToRow({ ...DEMO_COVERAGE_CHANGES[0], changeType: "coverage_removed" }).change_type).toBe("dropped");
  });

  it("preserves numeric quantity limits and source reversals", () => {
    const input = { ...DEMO_COVERAGE_CHANGES[0], changeType: "quantity_limit_tightened" as const, sourceResolvedAt: "2026-09-29T00:00:00.000Z" };
    const row = changeInputToRow(input);
    expect(row).toMatchObject({ change_type: "quantity_limit_tightened", source_resolved_at: input.sourceResolvedAt });
    expect(rowToChangeInput(row)).toMatchObject(input);
  });

  it("the SQL migration seeds exactly the demo alerts", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260927000000_coverage_alerts.sql"), "utf8");
    for (const change of DEMO_COVERAGE_CHANGES) {
      const row: CoverageAlertRow = changeInputToRow(change);
      for (const value of [row.id, row.plan_id, row.plan_name, row.change_type, row.old_value!, row.new_value!]) {
        expect(sql).toContain(`'${value}'`);
      }
    }
  });
});
