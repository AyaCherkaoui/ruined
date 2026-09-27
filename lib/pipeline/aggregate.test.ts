import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db";
import { initializeAggregate, persistRun, readRun } from "./aggregate-store";
import { ingestCmsSnapshot, type CmsSnapshot } from "./cms-snapshots";
import { classifyObservations, compareSnapshots, readChanges } from "./compare-snapshots";
import { declarePlanAcceptance, fetchPrescriberRows, loadPrescriberVolumes, matchPrescriberImpacts, normalizePrescriber, type CmsPrescriberRow } from "./prescriber-impact";
import { fetchCmsPage } from "./source-http";
import type { CoverageObservation } from "./aggregate-contract";

let db: Db;
let raw: string;
const fixture = async (name = "baseline") => JSON.parse(await fs.readFile(`data/fixtures/eliquis/${name}.json`, "utf8")) as CmsSnapshot;
const ingest = async (name: string, input?: CmsSnapshot) => ingestCmsSnapshot(db, JSON.stringify(input ?? await fixture(name)), name, raw);
beforeEach(async () => { db = await openDb({ path: ":memory:" }); await initializeAggregate(db); raw = await fs.mkdtemp(path.join(os.tmpdir(), "eliquis-test-")); });
afterEach(async () => { await db.close(); await fs.rm(raw, { recursive: true, force: true }); });

describe("CMS snapshot completeness and lineage", () => {
  it("replays exactly two plans and both strengths without duplicates and archives recoverable hashes", async () => {
    const first = await ingest("baseline");
    expect(first.run.status).toBe("completed");
    expect(first.observations).toHaveLength(4);
    expect((await ingest("baseline")).observations).toEqual(first.observations);
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*) n FROM coverage_observations");
    expect(n).toBe(4);
    expect(JSON.parse(await fs.readFile(path.join(raw, first.observations[0].rawArtifactHash + ".json"), "utf8"))).toEqual(await fixture());
  });
  it("rejects changing content under the same run id", async () => {
    await ingest("baseline");
    const changed = await fixture(); changed.entries[0].rows[0].tier = 4;
    await expect(ingest("baseline", changed)).rejects.toThrow("different content");
  });
  it("quarantines a bad row but keeps good rows; failed runs cannot create removals", async () => {
    await ingest("baseline");
    const input = await fixture("adverse"); input.entries[0].rows[0].tier = -1;
    const result = await ingest("adverse", input);
    expect(result.observations).toHaveLength(3);
    expect(result.run.status).toBe("failed");
    expect(result.run.quarantine[0].reason).toBe("Invalid tier");
    await expect(compareSnapshots(db, "baseline", "adverse")).rejects.toThrow("completed");
    expect(await readChanges(db)).toEqual([]);
  });
  it("missing entry fails; explicit empty complete entry means not covered", async () => {
    const missing = await fixture(); missing.entries.pop();
    expect((await ingest("missing", missing)).run.status).toBe("failed");
    const empty = await fixture(); empty.entries[0].rows = [];
    const result = await ingest("empty", empty);
    expect(result.run.status).toBe("completed");
    expect(result.observations[0].covered).toBe(false);
  });
  it("deduplicates identical records and quarantines contradictory NDC rows", async () => {
    const input = await fixture(); input.entries.push(structuredClone(input.entries[0]));
    expect((await ingest("duplicates", input)).observations).toHaveLength(4);
    input.entries[0].rows.push({ ...input.entries[0].rows[0], tier: 5, ndc: "00003089422" });
    expect((await ingest("conflict", input)).run.status).toBe("failed");
  });
});

describe("symmetric facts", () => {
  it.each([
    ["coverage_removed", "coverage_restored", { covered: false }],
    ["tier_increased", "tier_decreased", { tier: 4 }],
    ["prior_authorization_added", "prior_authorization_removed", { priorAuthorization: true }],
    ["step_therapy_added", "step_therapy_removed", { stepTherapy: true }],
    ["quantity_limit_added", "quantity_limit_removed", { quantityLimit: { applies: true, amount: null, days: null } }],
    ["quantity_limit_tightened", "quantity_limit_relaxed", { quantityLimit: { applies: true, amount: 30, days: 30 } }],
  ] as const)("classifies %s and its inverse %s", async (adverse, reverse, patch) => {
    const { observations } = await ingest("baseline");
    const a = structuredClone(observations[0]);
    if (adverse === "quantity_limit_added") a.quantityLimit = { applies: false, amount: null, days: null };
    const b = { ...a, ...patch } as CoverageObservation;
    expect(classifyObservations(a, b)).toEqual([adverse]);
    expect(classifyObservations(b, a)).toEqual([reverse]);
  });
  it("unknown restriction/tier never creates a fact and equal daily limits are equal", async () => {
    const { observations: [a] } = await ingest("baseline");
    const b = { ...a, tier: null, priorAuthorization: null, stepTherapy: null, quantityLimit: { applies: true, amount: 120, days: 60 } };
    expect(classifyObservations(a, b)).toEqual([]);
  });
  it("separate simultaneous facts resolve once and replays preserve reciprocal links", async () => {
    await ingest("baseline");
    const adverse = await fixture("adverse"); adverse.entries[0].rows[0].tier = 4;
    await ingest("adverse", adverse);
    const first = await compareSnapshots(db, "baseline", "adverse");
    expect(first.map((c) => c.changeType).sort()).toEqual(["prior_authorization_added", "tier_increased"]);
    expect(await compareSnapshots(db, "baseline", "adverse")).toEqual(first.sort((a, b) => a.id.localeCompare(b.id)));
    await ingest("restored");
    const reversals = await compareSnapshots(db, "adverse", "restored");
    expect(reversals).toHaveLength(2);
    const all = await readChanges(db);
    for (const reverse of reversals) expect(all.find((c) => c.id === reverse.resolvesChangeId)?.resolvedByChangeId).toBe(reverse.id);
    await compareSnapshots(db, "adverse", "restored");
    expect(await readChanges(db)).toEqual(all);
    await expect(compareSnapshots(db, "restored", "baseline")).rejects.toThrow("increasing");
    const saved = await readRun(db, "baseline");
    await expect(persistRun(db, { ...saved.run, id: "partial", expectedKeys: [] }, saved.observations.map((o) => ({ ...o, sourceRunId: "partial" })))).rejects.toThrow("Incomplete");
  });
});

const row = (overrides: Partial<CmsPrescriberRow> = {}): CmsPrescriberRow => ({ Prscrbr_NPI: "0000000000", Prscrbr_State_Abrvtn: "GA", Brnd_Name: "Eliquis", Gnrc_Name: "Apixaban", Tot_Clms: "184", ...overrides });
describe("prescriber impact", () => {
  it("normalizes brand/generic and preserves missing and suppressed values without zero", () => {
    expect(normalizePrescriber(row({ Brnd_Name: " APIXABAN " }), 2024, "fixture", "simulated")?.drug).toBe("apixaban");
    expect(normalizePrescriber(row({ Tot_Clms: "" }), 2024, "fixture", "simulated")).toMatchObject({ value: null, missing: true, suppressed: false });
    expect(normalizePrescriber(row({ Tot_Clms: "*" }), 2024, "fixture", "simulated")).toMatchObject({ value: null, suppressed: true });
    expect(normalizePrescriber(row({ Prscrbr_State_Abrvtn: "FL" }), 2024, "fixture", "simulated")).toBeNull();
    expect(() => normalizePrescriber(row({ Tot_Clms: "invalid" }), 2024, "fixture", "simulated")).toThrow();
  });
  it("loads idempotently, requires acceptance AND volume, and only emits open impacts", async () => {
    const base = await ingest("baseline"); await ingest("adverse"); await compareSnapshots(db, "baseline", "adverse");
    const rows = [row(), row(), row({ Prscrbr_NPI: "0000000001" }), row({ Prscrbr_NPI: "0000000002", Tot_Clms: "*" })];
    expect(await loadPrescriberVolumes(db, rows, 2024, "fixture", "simulated")).toBe(3);
    expect(await loadPrescriberVolumes(db, rows, 2024, "fixture", "simulated")).toBe(0);
    for (const npi of ["0000000000", "0000000002", "0000000003"]) await declarePlanAcceptance(db, npi, base.observations[0].plan);
    const impacts = await matchPrescriberImpacts(db, 2024);
    expect(impacts).toHaveLength(2);
    expect(impacts.map((i) => i.npi).sort()).toEqual(["0000000000", "0000000002"]);
    expect(impacts.every((i) => i.sourceYear === 2024 && i.estimate.metric === "total_claims" && i.qualityFlags.includes("not_plan_specific"))).toBe(true);
    expect(await matchPrescriberImpacts(db, 2024)).toEqual(impacts);
    expect((await db.query<{ n: number }>("SELECT count(*) n FROM patient_alerts"))[0].n).toBe(0);
    await ingest("restored"); await compareSnapshots(db, "adverse", "restored");
    expect(await matchPrescriberImpacts(db, 2024)).toEqual([]);
  });
  it("rolls back conflicting annual reloads rather than double counting", async () => {
    await loadPrescriberVolumes(db, [row()], 2024, "fixture");
    await expect(loadPrescriberVolumes(db, [row({ Prscrbr_NPI: "0000000001" }), row({ Tot_Clms: "200" })], 2024, "fixture")).rejects.toThrow("Conflicting");
    expect((await db.query<{ n: number }>("SELECT count(*) n FROM prescriber_drug_volume"))[0].n).toBe(1);
  });
});

describe("public CMS transport", () => {
  it("retries 429/503, archives pages, and never retries authentication errors", async () => {
    const send = vi.fn().mockResolvedValueOnce(new Response("slow", { status: 429 })).mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(new Response("[]"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await fetchCmsPage("https://data.cms.gov/test", 1, raw, { fetch: send, sleep })).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const unauthorized = vi.fn().mockResolvedValue(new Response("no", { status: 401 }));
    await expect(fetchCmsPage("https://data.cms.gov/test", 1, raw, { fetch: unauthorized, sleep })).rejects.toThrow("401");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
  it("paginates source-side filters and rejects repeated pages", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => row({ Prscrbr_NPI: String(i).padStart(10, "0") }));
    const send = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page))).mockResolvedValueOnce(new Response("[]"));
    const results = [];
    for await (const r of fetchPrescriberRows("9552739e-3d05-4c1b-8eff-ecabf391e2e5", raw, { fetch: send })) results.push(r);
    expect(results).toHaveLength(1000);
    expect(new URL(send.mock.calls[1][0]).searchParams.get("offset")).toBe("1000");
    expect(new URL(send.mock.calls[0][0]).searchParams.get("filter[Gnrc_Name]")).toBe("Apixaban");
    const repeated = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page)));
    await expect((async () => { for await (const r of fetchPrescriberRows("9552739e-3d05-4c1b-8eff-ecabf391e2e5", raw, { fetch: repeated })) void r; })()).rejects.toThrow("repeated");
  });
});
