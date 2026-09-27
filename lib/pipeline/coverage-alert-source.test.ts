import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { createCoverageAlertStore } from "../coverageAlerts";
import { initializeAggregate } from "./aggregate-store";
import { runDemo } from "./demo";
import { aggregateCoverageChanges, loadAggregateCoverageChanges } from "./coverage-alert-source";

let proof: Awaited<ReturnType<typeof runDemo>>;
let temporary: string;
beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-source-test-"));
  const db = await openDb({ path: ":memory:" });
  try { await initializeAggregate(db); proof = await runDemo(db, temporary); }
  finally { await db.close(); }
});
afterAll(async () => { vi.unstubAllEnvs(); await fs.rm(temporary, { recursive: true, force: true }); });

describe("aggregate pipeline to coverage alerts", () => {
  it("targets only active matched doctor impacts and rejects mismatched evidence", () => {
    expect(aggregateCoverageChanges(proof.adversePayload, "0000000000")).toHaveLength(1);
    expect(aggregateCoverageChanges(proof.adversePayload, "1111111111")).toHaveLength(0);
    expect(aggregateCoverageChanges({ ...proof.adversePayload, doctorImpacts: [] }, "0000000000")).toHaveLength(0);
    expect(aggregateCoverageChanges(proof.finalPayload, "0000000000")).toHaveLength(0);
    const malformed = structuredClone(proof.adversePayload);
    malformed.doctorImpacts[0].rxcui = "wrong";
    expect(() => aggregateCoverageChanges(malformed, "0000000000")).toThrow(/does not match/);
  });
  it("preserves facts, unknown effective dates, and simulation labels without inventing patient counts", () => {
    const [alert] = aggregateCoverageChanges(proof.adversePayload);
    expect(alert).toMatchObject({ id: proof.adversePayload.changes[0].id, changeType: "prior_auth_added",
      planId: "S5884-135-000", isDemo: true, effectiveDate: null, estimatedPatientRange: null });
    expect(alert.oldValue).toContain("No prior authorization");
    expect(alert.newValue).toContain("Prior authorization required");
    expect(alert.source).toContain("simulated");
  });

  it("rehearses publish, review, reset and source reversal three times without restarting", async () => {
    const file = path.join(temporary, "payload.json");
    vi.stubEnv("COVERAGE_ALERTS_PAYLOAD", file);
    const store = createCoverageAlertStore(loadAggregateCoverageChanges);
    for (let pass = 0; pass < 3; pass++) {
      await fs.writeFile(file, JSON.stringify({ ...proof.adversePayload, changes: [], doctorImpacts: [] }));
      await store.reset();
      expect(await store.list()).toEqual([]);
      await fs.writeFile(file, JSON.stringify(proof.adversePayload));
      const [alert] = await store.list();
      expect(alert.status).toBe("open");
      const reviewed = await store.resolve(alert.id);
      expect(reviewed?.status).toBe("resolved");
      expect(await store.resolve(alert.id)).toEqual(reviewed);
      await store.reset();
      expect((await store.get(alert.id))?.status).toBe("open");
      await fs.writeFile(file, JSON.stringify(proof.finalPayload));
      expect((await store.get(alert.id))?.status).toBe("resolved");
      await store.reset();
      expect((await store.get(alert.id))?.status).toBe("resolved");
      expect((await store.list()).find((a) => a.changeType === "prior_auth_removed")?.actions).toEqual([]);
    }
  });

  it("fails closed on missing files, corrupt input and missing evidence", async () => {
    const file = path.join(temporary, "invalid.json");
    vi.stubEnv("COVERAGE_ALERTS_PAYLOAD", file);
    await expect(loadAggregateCoverageChanges()).rejects.toMatchObject({ status: 503 });
    await fs.writeFile(file, "{}");
    await expect(loadAggregateCoverageChanges()).rejects.toMatchObject({ status: 503 });
    expect(() => aggregateCoverageChanges({ ...proof.adversePayload, observations: [] })).toThrow(/observations/);
    const broken = structuredClone(proof.finalPayload);
    broken.changes = broken.changes.filter((c) => c.direction !== "improved");
    expect(() => aggregateCoverageChanges(broken)).toThrow(/resolution link/);
  });

  it("reports numeric quantity-limit changes accurately", async () => {
    const payload = structuredClone(proof.adversePayload);
    const fact = payload.changes[0];
    const old = payload.observations.find((o) => o.id === fact.oldObservationId)!;
    const next = payload.observations.find((o) => o.id === fact.newObservationId)!;
    next.priorAuthorization = old.priorAuthorization;
    old.quantityLimit = { applies: true, amount: 60, days: 30 };
    next.quantityLimit = { applies: true, amount: 30, days: 30 };
    fact.changeType = "quantity_limit_tightened";
    const [alert] = await createCoverageAlertStore(async () => aggregateCoverageChanges(payload)).list();
    expect(alert.summary).toContain("tightened");
    expect(alert.oldValue).toContain("60 per 30 days");
    expect(alert.newValue).toContain("30 per 30 days");
    expect(alert.actions.length).toBeGreaterThan(0);
  });
});
