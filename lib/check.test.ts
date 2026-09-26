import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "./check";
import { PlanNotFoundError } from "./coverage";
import { openDb, type Db } from "./db";
import { ApiError } from "./http";
import { RxNavClient } from "./rxnav";
import { addDrug, addPatient, addPlan, addTier, TEST_PLAN } from "./testing";

// runCheck against a synthetic plan and a fake RxNav (no network).

const concept = (rxcui: string, name: string, tty: string) => ({ rxcui, name, tty, synonym: "", language: "ENG" });
const PROPS: Record<string, ReturnType<typeof concept>> = {
  "100": concept("100", "brandex 10 MG Oral Tablet [Brandex]", "SBD"),
  "101": concept("101", "genericol 10 MG Oral Tablet", "SCD"),
  "900": concept("900", "Brandex", "BN"),
};
const EXACT: Record<string, string[]> = { "brandex tablet": ["100"], brandex: ["900"] };

function fakeRxNav(down = false) {
  const fetchFn = (async (input: RequestInfo | URL) => {
    if (down) throw new TypeError("fetch failed");
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes("/rxcui.json?name=")) {
      const alias = decodeURIComponent(url.match(/name=([^&]*)/)![1]);
      return json({ idGroup: EXACT[alias] ? { rxnormId: EXACT[alias] } : {} });
    }
    if (url.includes("/approximateTerm.json")) return json({ approximateGroup: { candidate: [] } });
    if (url.includes("/properties.json")) return json({ properties: PROPS[url.match(/rxcui\/(\d+)\/properties/)![1]] });
    if (url.includes("/related.json")) {
      return json({ relatedGroup: { conceptGroup: [{ tty: "IN", conceptProperties: [concept("I1", "brandexin", "IN")] }, { tty: "DFG", conceptProperties: [concept("1", "Oral Product", "DFG")] }] } });
    }
    if (url.includes("/rxclass/class/byRxcui.json")) {
      return json({ rxclassDrugInfoList: { rxclassDrugInfo: [{ minConcept: { rxcui: "I1", name: "brandexin", tty: "IN" }, rxclassMinConceptItem: { classId: "C10AA", className: "Statins", classType: "ATC1-4" } }] } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return new RxNavClient({ fetch: fetchFn, minIntervalMs: 0, maxRetries: 0 });
}

let db: Db;

beforeAll(async () => {
  db = await openDb({ path: ":memory:" });
  await addPlan(db);
  await addTier(db, 1, 1, 5);
  await addTier(db, 3, 2, 0.25);
  // brand tier 3: 30 x $10 = $300 -> 25% = $75; its generic: 30 x $0.5 = $15 -> $5 copay
  await addDrug(db, { rxcui: "100", name: "brandex 10 MG Oral Tablet [Brandex]", ingredient: "I1", tier: 3, unit: 10, tty: "SBD", generic: "101" });
  await addDrug(db, { rxcui: "101", name: "genericol 10 MG Oral Tablet", ingredient: "I1", tier: 1, unit: 0.5 });
  await addPatient(db, { id: "pt-x", name: "Test Patient" }, TEST_PLAN, [["100", "brandex"]]);
});
afterAll(async () => {
  await db.close();
});

const rejectsWith = async (p: Promise<unknown>, status: number, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  if (message) expect((err as ApiError).message).toMatch(message);
  return err as ApiError;
};

describe("runCheck", () => {
  it("answers by patientId + rxcui: coverage plus the generic alternative", async () => {
    const r = await runCheck({ patientId: "pt-x", rxcui: "100" }, db);
    expect(r.coverage).toEqual({
      rxcui: "100",
      drugName: "brandex 10 MG Oral Tablet [Brandex]",
      status: "covered",
      tier: 3,
      priorAuth: false,
      stepTherapy: false,
      quantityLimit: false,
      estMonthlyCost: 75,
      isEstimate: true,
    });
    expect(r.alternatives).toHaveLength(1);
    expect(r.alternatives[0]).toMatchObject({ rxcui: "101", estMonthlyCost: 5, monthlySavings: 70 });
  });

  it("answers by explicit plan ids (segmentId defaults to 000)", async () => {
    const r = await runCheck({ contractId: "H0001", planId: "001", rxcui: "101" }, db);
    expect(r.coverage).toMatchObject({ rxcui: "101", tier: 1, estMonthlyCost: 5 });
    expect(r.alternatives).toEqual([]); // the generic is already the cheapest
  });

  it("resolves a drug name through the normalizer", async () => {
    const r = await runCheck({ patientId: "pt-x", drugName: "Brandex Tablet" }, db, fakeRxNav());
    expect(r.coverage.rxcui).toBe("100");
    expect(r.alternatives[0].rxcui).toBe("101");
  });

  it("refuses a bare brand/ingredient name (no strength) with a pick-list from the plan's formulary", async () => {
    const err = await rejectsWith(runCheck({ patientId: "pt-x", drugName: "Brandex" }, db, fakeRxNav()), 422, /without a strength/);
    expect(err.details?.matched).toEqual({ rxcui: "900", drugName: "Brandex" });
    expect((err.details?.choices as { rxcui: string }[]).map((c) => c.rxcui)).toEqual(["100", "101"]);
  });

  it("404s for a drug name nothing matches", async () => {
    await rejectsWith(runCheck({ patientId: "pt-x", drugName: "zzz" }, db, fakeRxNav()), 404, /No drug found/);
  });

  it("502s when RxNav is unreachable (not a 500)", async () => {
    await rejectsWith(runCheck({ patientId: "pt-x", drugName: "never seen before" }, db, fakeRxNav(true)), 502, /RxNav/);
  });

  it("never needs the network for an rxcui request", async () => {
    // no RxNav client passed and none reachable in this test: rxcui path must not call it for the answer
    const r = await runCheck({ patientId: "pt-x", rxcui: "100" }, db);
    expect(r.coverage.rxcui).toBe("100");
  });

  it("validates input", async () => {
    await rejectsWith(runCheck({}, db), 400, /patientId, or contractId and planId/);
    await rejectsWith(runCheck({ patientId: "pt-x" }, db), 400, /rxcui or drugName/);
    await rejectsWith(runCheck({ patientId: "pt-x", rxcui: "12ab" }, db), 400, /numeric/);
    await rejectsWith(runCheck({ contractId: "H0001" }, db), 400);
    await rejectsWith(runCheck({ patientId: "   ", rxcui: "100" }, db), 400); // blank counts as missing
  });

  it("404s for an unknown patient; throws PlanNotFoundError for an unknown plan", async () => {
    await rejectsWith(runCheck({ patientId: "pt-nope", rxcui: "100" }, db), 404, /Patient pt-nope not found/);
    await expect(runCheck({ contractId: "H9999", planId: "999", rxcui: "100" }, db)).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
