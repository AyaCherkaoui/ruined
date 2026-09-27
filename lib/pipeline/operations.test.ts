import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db";
import { hash, initializeAggregate, readRun } from "./aggregate-store";
import { ingestCmsSnapshot, type CmsSnapshot } from "./cms-snapshots";
import { compareSnapshots, readChanges } from "./compare-snapshots";
import { runDemo } from "./demo";
import { acquirePipelineLock, acquireWithRetry, retentionInventory, runDaily } from "./daily-runner";
import { crossCheck, type AlignedSource } from "./cross-source";
import { consolePreviewAdapter, drainSmsPreviews, enqueueSmsPreviews, normalizeReply, readOutbox } from "./sms-outbox";
import { declarePlanAcceptance, loadPrescriberVolumes } from "./prescriber-impact";

let root: string;
let db: Db;
const fixture = async (name = "real-baseline") => JSON.parse(await fs.readFile(`data/fixtures/eliquis/${name}.json`, "utf8")) as CmsSnapshot;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "eliquis-ops-test-")); db = await openDb({ path: ":memory:" }); await initializeAggregate(db); });
afterEach(async () => { await db.close(); await fs.rm(root, { recursive: true, force: true }); });

describe("real baseline offline proof", () => {
  it("reproduces two independent passes plus duplicate-free same-database replays", async () => {
    const first = await runDemo(db, root);
    const other = await openDb({ path: ":memory:" });
    try { await initializeAggregate(other); expect(await runDemo(other, root)).toEqual(first); }
    finally { await other.close(); }
    expect(first.adversePayload.observations.filter((o) => o.provenance === "replay")).toHaveLength(4);
    expect(first.finalPayload.changes.every((c) => c.provenance === "simulated")).toBe(true);
    expect(first.adversePayload.doctorImpacts[0].qualityFlags).toContain("simulated_source");
  });
});

describe("daily orchestration", () => {
  const daily = (input: CmsSnapshot | string, runId: string, commit = true) => runDaily({ dbPath: path.join(root, "daily.duckdb"), runId, sourceYear: 2024, commit, artifactRoot: root, acquire: async () => typeof input === "string" ? input : JSON.stringify(input) });
  it("dry-run leaves the target DB absent and later unchanged; commits no-change runs idempotently", async () => {
    const input = await fixture();
    expect((await daily(input, "baseline", false)).status).toBe("completed");
    await expect(fs.access(path.join(root, "daily.duckdb"))).rejects.toThrow();
    expect((await daily(input, "baseline")).status).toBe("completed");
    const original = hash(await fs.readFile(path.join(root, "daily.duckdb"), "base64"));
    input.capturedAt = "2026-09-28T00:00:00.000Z";
    expect((await daily(input, "unchanged-preview", false)).newFacts).toBe(0);
    expect(hash(await fs.readFile(path.join(root, "daily.duckdb"), "base64"))).toBe(original);
    expect(await daily(input, "unchanged")).toMatchObject({ status: "completed", newFacts: 0, newImpacts: 0, previousRunId: "baseline" });
    expect(await daily(input, "unchanged")).toMatchObject({ status: "completed", replayed: true, newFacts: 0, newImpacts: 0 });
    input.entries[0].rows[0].tier = 9;
    expect((await daily(input, "unchanged")).status).toBe("failed");
  });
  it("malformed/quarantined runs never become baselines; later valid runs extend the last complete run", async () => {
    const input = await fixture(); await daily(input, "baseline");
    expect((await daily("{bad json", "malformed")).status).toBe("failed");
    const broken = structuredClone(input); broken.capturedAt = "2026-09-28T00:00:00.000Z"; broken.entries.pop();
    expect(await daily(broken, "incomplete")).toMatchObject({ status: "failed", observations: 3, newFacts: 0 });
    input.capturedAt = "2026-09-29T00:00:00.000Z";
    input.entries[0].rows[0].prior_authorization = true;
    expect(await daily(input, "valid")).toMatchObject({ status: "completed", previousRunId: "baseline", newFacts: 1 });
    const stored = await openDb({ path: path.join(root, "daily.duckdb"), readOnly: true });
    try { expect((await readRun(stored, "incomplete")).run.status).toBe("failed"); expect(await readChanges(stored)).toHaveLength(1); }
    finally { await stored.close(); }
    expect(await fs.readdir(path.join(root, "attempts"))).toHaveLength(4);
  });
  it("creates one aggregate impact, keeps it through no-change runs, and resolves it on reversal", async () => {
    const baseline = await fixture(); await daily(baseline, "baseline");
    const setup = await openDb({ path: path.join(root, "daily.duckdb") });
    try {
      await loadPrescriberVolumes(setup, [{ Prscrbr_NPI: "0000000000", Prscrbr_State_Abrvtn: "GA", Brnd_Name: "Eliquis", Gnrc_Name: "Apixaban", Tot_Clms: "184" }], 2024, "synthetic-operations", "simulated");
      await declarePlanAcceptance(setup, "0000000000", baseline.plans[0]);
    } finally { await setup.close(); }
    const adverse = structuredClone(baseline); adverse.provenance = "simulated";
    adverse.capturedAt = "2026-09-28T00:00:00.000Z"; adverse.entries[0].rows[0].prior_authorization = true;
    expect(await daily(adverse, "adverse")).toMatchObject({ status: "completed", newFacts: 1, newImpacts: 1, activeImpacts: 1 });
    expect(await daily(adverse, "adverse")).toMatchObject({ replayed: true, newFacts: 0, newImpacts: 0, activeImpacts: 1 });
    adverse.capturedAt = "2026-09-29T00:00:00.000Z";
    expect(await daily(adverse, "no-change")).toMatchObject({ status: "completed", newFacts: 0, newImpacts: 0, activeImpacts: 1 });
    const restored = structuredClone(baseline); restored.provenance = "simulated"; restored.capturedAt = "2026-09-30T00:00:00.000Z";
    expect(await daily(restored, "restored")).toMatchObject({ status: "completed", newFacts: 1, newImpacts: 0, activeImpacts: 0 });
    adverse.capturedAt = "2026-09-28T00:00:00.000Z";
    expect(await daily(adverse, "adverse")).toMatchObject({ replayed: true, newFacts: 0, newImpacts: 0, activeImpacts: 0 });
  });
  it("rolls back an out-of-order complete snapshot and releases the overlap lock", async () => {
    const input = await fixture(); await daily(input, "baseline");
    input.capturedAt = "2026-09-26T00:00:00.000Z";
    expect((await daily(input, "too-old")).status).toBe("failed");
    const stored = await openDb({ path: path.join(root, "daily.duckdb"), readOnly: true });
    try { await expect(readRun(stored, "too-old")).rejects.toThrow("Unknown run"); }
    finally { await stored.close(); }
    const release = await acquirePipelineLock(path.join(root, "daily.duckdb")); await release();
  });
  it("rolls back facts and observations when matching fails after comparison", async () => {
    const input = await fixture(); await daily(input, "baseline");
    const selectedPath = path.join(root, "daily.duckdb");
    const corrupt = await openDb({ path: selectedPath });
    try { await corrupt.run("INSERT INTO prescriber_drug_volume VALUES (2024,'0000000000','apixaban','invalid-json')"); }
    finally { await corrupt.close(); }
    input.capturedAt = "2026-09-28T00:00:00.000Z"; input.entries[0].rows[0].prior_authorization = true;
    expect(await daily(input, "match-failed")).toMatchObject({ status: "failed", newFacts: 0, error: expect.stringContaining("match failed") });
    const stored = await openDb({ path: selectedPath, readOnly: true });
    try { expect(await readChanges(stored)).toEqual([]); await expect(readRun(stored, "match-failed")).rejects.toThrow("Unknown run"); }
    finally { await stored.close(); }
  });
  it("rejects overlapping runs before acquisition; bounds transient retries and does not retry permanent errors", async () => {
    const selected = path.join(root, "locked.duckdb"); const release = await acquirePipelineLock(selected);
    const acquire = vi.fn(async () => "{}");
    try { await expect(runDaily({ dbPath: selected, runId: "overlap", sourceYear: 2024, artifactRoot: root, acquire })).rejects.toThrow("overlap"); expect(acquire).not.toHaveBeenCalled(); }
    finally { await release(); }
    const transient = vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    const sleep = vi.fn(async () => {});
    await expect(acquireWithRetry(transient, sleep)).rejects.toThrow("busy");
    expect(transient).toHaveBeenCalledTimes(4); expect(sleep.mock.calls).toHaveLength(3);
    const permanent = vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    await expect(acquireWithRetry(permanent, sleep)).rejects.toThrow("missing"); expect(permanent).toHaveBeenCalledTimes(1);
  });
  it("archives acquisition failures without exposing exception content", async () => {
    const result = await runDaily({ dbPath: path.join(root, "missing.duckdb"), runId: "failed", sourceYear: 2024, artifactRoot: root, acquire: async () => { throw new Error("secret-token"); } });
    expect(result).toMatchObject({ status: "failed", inputHash: null });
    const [name] = await fs.readdir(path.join(root, "attempts"));
    expect(await fs.readFile(path.join(root, "attempts", name), "utf8")).not.toContain("secret-token");
  });
  it("inventories retained source artifacts without mutating them", async () => {
    const input = await fixture(); const ingested = await ingestCmsSnapshot(db, JSON.stringify(input), "retained", root);
    const digest = ingested.observations[0].rawArtifactHash;
    const old = new Date("2020-01-01"); await fs.utimes(path.join(root, digest + ".json"), old, old);
    const before = await fs.readFile(path.join(root, digest + ".json"), "utf8");
    const inventory = await retentionInventory(db, root, 90, Date.parse("2026-09-27"));
    expect(inventory.files.find((f) => f.file === digest + ".json")).toMatchObject({ referenced: true, olderThanPolicy: true });
    expect(await fs.readFile(path.join(root, digest + ".json"), "utf8")).toBe(before);
  });
});

describe("aligned source discrepancy report", () => {
  async function inputs() {
    const result = await ingestCmsSnapshot(db, JSON.stringify(await fixture()), "cms", root);
    const cms: AlignedSource = { effectivePeriod: { start: "2026-09-01", end: "2026-10-01" }, observations: result.observations };
    const humana = structuredClone(cms);
    for (const o of humana.observations) { o.source = "humana_fhir"; o.id = "humana-" + o.id; o.sourceRunId = "humana"; o.provenance = "simulated"; o.rawArtifactHash = "b".repeat(64); }
    return { cms, humana, mappings: (await fixture()).plans.map((p) => ({ cms: p, humana: p })) };
  }
  it("distinguishes agreement, true disagreement, mapping gaps, and timing mismatch with both lineages", async () => {
    const { cms, humana, mappings } = await inputs();
    expect(crossCheck(cms, humana, mappings).checks.every((c) => c.status === "agreement")).toBe(true);
    humana.observations[0].covered = false;
    const report = crossCheck(cms, humana, mappings);
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({ field: "covered", severity: "high" });
    expect(report.discrepancies[0].lineage.map((l) => l.source)).toEqual(["cms_monthly", "humana_fhir"]);
    expect(crossCheck(cms, humana, []).checks.every((c) => c.status === "missing_mapping")).toBe(true);
    humana.effectivePeriod = { start: "2026-10-01", end: "2026-11-01" };
    expect(crossCheck(cms, humana, mappings).checks.every((c) => c.status === "timing_mismatch")).toBe(true);
    expect(crossCheck(cms, humana, mappings).discrepancies).toEqual([]);
    expect(await readChanges(db)).toEqual([]);
  });
  it("never converts unknown restrictions, missing rows, or unproven dates into disagreement", async () => {
    const { cms, humana, mappings } = await inputs();
    humana.observations[0].tier = null;
    humana.observations[1].quantityLimit.amount! *= 2; humana.observations[1].quantityLimit.days! *= 2;
    humana.observations.pop();
    const report = crossCheck(cms, humana, mappings);
    expect(report.discrepancies).toEqual([]);
    expect(report.checks.map((c) => c.status)).toContain("unknown_values");
    expect(report.checks.map((c) => c.status)).toContain("missing_observation");
    humana.effectivePeriod = null;
    expect(crossCheck(cms, humana, mappings).discrepancies).toEqual([]);
    expect(() => crossCheck(cms, humana, [...mappings, mappings[0]])).toThrow("one-to-one");
  });
});

describe("console-only idempotent SMS outbox", () => {
  async function prepare() {
    await ingestCmsSnapshot(db, JSON.stringify(await fixture("baseline")), "baseline", root);
    await ingestCmsSnapshot(db, JSON.stringify(await fixture("adverse")), "adverse", root);
    await compareSnapshots(db, "baseline", "adverse");
    await loadPrescriberVolumes(db, [{ Prscrbr_NPI: "0000000000", Prscrbr_State_Abrvtn: "GA", Brnd_Name: "Eliquis", Gnrc_Name: "Apixaban", Tot_Clms: "184" }], 2024, "fixture", "simulated");
    await declarePlanAcceptance(db, "0000000000", (await fixture("baseline")).plans[0]);
  }
  it("formats honest aggregate content, redacts logs, and previews only once on repeated enqueue/drain", async () => {
    await prepare(); await enqueueSmsPreviews(db, 2024); await enqueueSmsPreviews(db, 2024);
    expect(await readOutbox(db)).toHaveLength(1);
    const log = vi.fn(); const network = vi.spyOn(globalThis, "fetch");
    try {
      await drainSmsPreviews(db, consolePreviewAdapter(log)); await drainSmsPreviews(db, consolePreviewAdapter(log));
      expect(log).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
      const output = log.mock.calls[0][0];
      expect(output).toContain("annual apixaban claims: 184"); expect(output).toContain("not an affected-patient count");
      expect(output).toContain("simulated"); expect(output).toContain("[redacted]"); expect(output).not.toContain("0000000000");
    } finally { network.mockRestore(); }
  });
  it("retries failed previews with a persisted budget and never stores exception secrets", async () => {
    await prepare(); await enqueueSmsPreviews(db, 2024);
    const preview = vi.fn(async () => { throw new Error("+15555555555 token=secret"); });
    for (let i = 0; i < 5; i++) await drainSmsPreviews(db, { mode: "console-only", preview });
    expect(preview).toHaveBeenCalledTimes(3);
    const entries = await readOutbox(db); expect(entries[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(JSON.stringify(entries)).not.toContain("token=secret");
  });
  it("can recover a transient preview failure and cancels resolved pending impacts", async () => {
    await prepare(); await enqueueSmsPreviews(db, 2024);
    await drainSmsPreviews(db, { mode: "console-only", preview: async () => { throw new Error("temporary"); } });
    const log = vi.fn(); await drainSmsPreviews(db, consolePreviewAdapter(log));
    expect((await readOutbox(db))[0]).toMatchObject({ status: "previewed", attempts: 2 });
    // Reset only the console preview state to model a queued preview awaiting processing.
    const [entry] = await readOutbox(db); entry.status = "pending";
    await db.run("UPDATE sms_outbox SET status='pending', payload=$1 WHERE id=$2", [JSON.stringify(entry), entry.id]);
    await ingestCmsSnapshot(db, JSON.stringify(await fixture("restored")), "restored", root);
    await compareSnapshots(db, "adverse", "restored");
    await drainSmsPreviews(db, consolePreviewAdapter(log));
    expect(log).toHaveBeenCalledTimes(1); expect((await readOutbox(db))[0].status).toBe("cancelled");
  });
  it.each([[" STOP ", "stop"], ["unsubscribe", "stop"], ["start", "start"], ["Ack", "acknowledge"], ["yes", "acknowledge"], ["please stop later", "unknown"]])("normalizes %s without applying workflow or subscription state", (input, result) => { expect(normalizeReply(input)).toBe(result); });
});
