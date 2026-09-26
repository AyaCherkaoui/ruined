import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { fetchDrugRecord, getDrug, normalizeAlias, normalizeDrug } from "./drugs";
import { pickPrimaryClass, RxNavClient, type AtcClass } from "./rxnav";

// Fixtures mirror real RxNav / RxClass responses (captured 2026-09-26).
const concept = (rxcui: string, name: string, tty: string) => ({ rxcui, name, tty, synonym: "", language: "ENG" });
const PROPS: Record<string, ReturnType<typeof concept>> = {
  "617311": concept("617311", "atorvastatin 40 MG Oral Tablet", "SCD"),
  "617320": concept("617320", "atorvastatin 40 MG Oral Tablet [Lipitor]", "SBD"),
  "861748": concept("861748", "glyburide 2.5 MG / metformin hydrochloride 500 MG Oral Tablet", "SCD"),
  "316151": concept("316151", "lisinopril 10 MG", "SCDC"),
  "314076": concept("314076", "lisinopril 10 MG Oral Tablet", "SCD"),
  "1991307": concept("1991307", "Ozempic", "BN"),
};
const RELATED: Record<string, object> = {
  "617311": { relatedGroup: { conceptGroup: [
    { tty: "DFG", conceptProperties: [concept("1151131", "Oral Product", "DFG"), concept("1151133", "Pill", "DFG")] },
    { tty: "IN", conceptProperties: [concept("83367", "atorvastatin", "IN")] },
    { tty: "MIN" },
    { tty: "SCD", conceptProperties: [PROPS["617311"]] },
  ] } },
  "861748": { relatedGroup: { conceptGroup: [
    { tty: "DFG", conceptProperties: [concept("1151131", "Oral Product", "DFG")] },
    { tty: "IN", conceptProperties: [concept("4815", "glyburide", "IN"), concept("6809", "metformin", "IN")] },
    { tty: "MIN", conceptProperties: [concept("285129", "glyburide / metformin", "MIN")] },
  ] } },
};
RELATED["617320"] = RELATED["617311"];
RELATED["314076"] = { relatedGroup: { conceptGroup: [
  { tty: "DFG", conceptProperties: [concept("1151131", "Oral Product", "DFG")] },
  { tty: "IN", conceptProperties: [concept("29046", "lisinopril", "IN")] },
  { tty: "MIN" },
] } };
RELATED["1991307"] = { relatedGroup: { conceptGroup: [
  { tty: "IN", conceptProperties: [concept("1991302", "semaglutide", "IN")] },
] } };
const item = (viaRxcui: string, viaName: string, viaTty: string, classId: string, className: string) => ({
  minConcept: { rxcui: viaRxcui, name: viaName, tty: viaTty },
  rxclassMinConceptItem: { classId, className, classType: "ATC1-4" },
  rela: "",
  relaSource: "ATC",
});
const CLASSES: Record<string, object> = {
  "617311": { rxclassDrugInfoList: { rxclassDrugInfo: [item("83367", "atorvastatin", "IN", "C10AA", "HMG CoA reductase inhibitors")] } },
  "617320": { rxclassDrugInfoList: { rxclassDrugInfo: [item("83367", "atorvastatin", "IN", "C10AA", "HMG CoA reductase inhibitors")] } },
  "314076": { rxclassDrugInfoList: { rxclassDrugInfo: [item("29046", "lisinopril", "IN", "C09AA", "ACE inhibitors, plain")] } },
  "1991307": { rxclassDrugInfoList: { rxclassDrugInfo: [item("1991302", "semaglutide", "IN", "A10BJ", "Glucagon-like peptide-1 (GLP-1) analogues")] } },
  "861748": { rxclassDrugInfoList: { rxclassDrugInfo: [
    item("4815", "glyburide", "IN", "A10BB", "Sulfonylureas"),
    item("6809", "metformin", "IN", "A10BA", "Biguanides"),
  ] } },
};

/** A fake RxNav server. `calls` records every URL so tests can assert cache behavior. */
function fakeRxNav(exactNames: Record<string, string[]> = {}, approx: object[] = []) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const rxcuiIn = (re: RegExp) => url.match(re)?.[1] ?? "";
    if (url.includes("/rxcui.json?name=")) {
      const name = decodeURIComponent(url.match(/name=([^&]*)/)![1]);
      return json({ idGroup: exactNames[name] ? { rxnormId: exactNames[name] } : {} });
    }
    if (url.includes("/approximateTerm.json")) return json({ approximateGroup: { candidate: approx } });
    if (url.includes("/properties.json")) {
      const p = PROPS[rxcuiIn(/rxcui\/(\d+)\/properties/)];
      return json(p ? { properties: p } : {});
    }
    if (url.includes("/related.json")) return json(RELATED[rxcuiIn(/rxcui\/(\d+)\/related/)] ?? {});
    if (url.includes("/rxclass/class/byRxcui.json")) return json(CLASSES[url.match(/rxcui=(\d+)/)![1]] ?? {});
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { rx: new RxNavClient({ fetch: fetchFn, minIntervalMs: 0, maxRetries: 0 }), calls };
}

describe("normalizeAlias", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeAlias("  Lipitor,  40MG ")).toBe("lipitor 40mg");
    expect(normalizeAlias("Atorvastatin  (Lipitor) 40 mg/tab")).toBe("atorvastatin lipitor 40 mg/tab");
  });
});

describe("pickPrimaryClass", () => {
  const c = (classId: string, viaTty: string, viaRxcui = "1"): AtcClass => ({ classId, className: classId, classType: "ATC1-4", viaRxcui, viaTty });
  const one = [{ rxcui: "1", name: "x", tty: "IN" }];
  it("uses the ingredient's level-4 class for a single-ingredient drug", () => {
    expect(pickPrimaryClass([c("C10AA", "IN")], one)?.classId).toBe("C10AA");
  });
  it("ignores combination classes RxClass mixes into an ingredient lookup", () => {
    expect(pickPrimaryClass([c("C10BA", "MIN"), c("C10AA", "IN")], one)?.classId).toBe("C10AA");
  });
  it("ignores non level-4 ATC ids", () => {
    expect(pickPrimaryClass([c("C10", "IN"), c("C10AA05", "IN")], one)).toBeNull();
  });
  it("is deterministic when an ingredient has several classes", () => {
    expect(pickPrimaryClass([c("N02BA", "IN"), c("B01AC", "IN")], one)?.classId).toBe("B01AC");
  });
  it("gives a combination no class unless the combination itself has one", () => {
    const two = [{ rxcui: "1", name: "a", tty: "IN" }, { rxcui: "2", name: "b", tty: "IN" }];
    expect(pickPrimaryClass([c("A10BB", "IN"), c("A10BA", "IN")], two)).toBeNull();
    expect(pickPrimaryClass([c("C10BX", "MIN"), c("C10AA", "IN")], two)?.classId).toBe("C10BX");
  });
});

describe("drug normalizer (mocked RxNav)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb({ path: ":memory:" });
  });
  afterEach(async () => {
    await db.close();
  });

  it("builds a record with rxcui, ingredient, class and route family", async () => {
    const { rx } = fakeRxNav();
    const d = await fetchDrugRecord("617311", rx);
    expect(d).toMatchObject({
      rxcui: "617311",
      name: "atorvastatin 40 MG Oral Tablet",
      tty: "SCD",
      ingredientRxcui: "83367",
      ingredientName: "atorvastatin",
      classId: "C10AA",
      className: "HMG CoA reductase inhibitors",
      doseFormGroup: "Oral Product",
      genericRxcui: null,
    });
  });

  it("links a brand (SBD) to its generic", async () => {
    const { rx } = fakeRxNav();
    const d = await fetchDrugRecord("617320", rx);
    expect(d?.tty).toBe("SBD");
    expect(d?.genericRxcui).toBe("617311");
  });

  it("gives combination drugs no class", async () => {
    const { rx } = fakeRxNav();
    const d = await fetchDrugRecord("861748", rx);
    expect(d?.ingredientRxcui).toBe("285129"); // the MIN
    expect(d?.classId).toBeNull();
  });

  it("resolves an exact name to an rxcui and caches drug + alias", async () => {
    const { rx, calls } = fakeRxNav({ "atorvastatin 40 mg oral tablet": ["617311"] });
    const d = await normalizeDrug(db, "Atorvastatin 40 MG oral tablet", rx);
    expect(d?.rxcui).toBe("617311");
    expect(d?.classId).toBe("C10AA");

    const before = calls.length;
    const again = await normalizeDrug(db, "atorvastatin  40 mg ORAL tablet", rx);
    expect(again).toEqual(d);
    expect(calls.length).toBe(before); // second lookup came entirely from the cache
    expect((await db.query("SELECT * FROM drugs")).length).toBe(1);
  });

  it("falls back to approximate match and prefers a specific clinical drug over a component", async () => {
    // 617319 has no PROPS entry (like a component concept) -> skipped; 617320 (SBD) wins.
    const { rx } = fakeRxNav({}, [
      { rxcui: "617319", score: "13.5", rank: "1", name: "atorvastatin 40 MG [Lipitor]" },
      { rxcui: "617320", score: "13.5", rank: "1" },
    ]);
    const d = await normalizeDrug(db, "lipitor 40mg", rx);
    expect(d?.rxcui).toBe("617320");
    expect(d?.tty).toBe("SBD");
  });

  it("upgrades an exact match on a partial concept (ingredient + strength) to a full SCD", async () => {
    // "lisinopril 10 mg" matches SCDC 316151 exactly, but formularies list the SCD (with dose form).
    const { rx } = fakeRxNav({ "lisinopril 10 mg": ["316151"] }, [
      { rxcui: "316151", score: "12.0", rank: "1" },
      { rxcui: "314076", score: "12.0", rank: "1" },
    ]);
    const d = await normalizeDrug(db, "lisinopril 10 mg", rx);
    expect(d?.rxcui).toBe("314076");
    expect(d?.tty).toBe("SCD");
  });

  it("keeps a bare brand name as the brand concept (no strength to choose)", async () => {
    const { rx } = fakeRxNav({ ozempic: ["1991307"] }, [{ rxcui: "617311", score: "5", rank: "1" }]);
    const d = await normalizeDrug(db, "Ozempic", rx);
    expect(d?.rxcui).toBe("1991307");
    expect(d?.tty).toBe("BN");
    expect(d?.classId).toBe("A10BJ");
  });

  it("returns null when nothing matches", async () => {
    const { rx } = fakeRxNav();
    expect(await normalizeDrug(db, "zzzz not a drug", rx)).toBeNull();
    expect(await normalizeDrug(db, "   ", rx)).toBeNull();
  });

  it("getDrug is cache-first", async () => {
    const { rx, calls } = fakeRxNav();
    await getDrug(db, "617311", rx);
    const n = calls.length;
    await getDrug(db, "617311", rx);
    expect(calls.length).toBe(n);
  });
});

// Opt-in smoke test against the real public API: RXNAV_LIVE=1 npx vitest run lib/drugs.test.ts
describe.skipIf(!process.env.RXNAV_LIVE)("live RxNav", () => {
  it("normalizes atorvastatin 40 mg to a statin", async () => {
    const db = await openDb({ path: ":memory:" });
    const d = await normalizeDrug(db, "atorvastatin 40 mg oral tablet", new RxNavClient());
    expect(d?.rxcui).toBe("617311");
    expect(d?.classId).toBe("C10AA");
    await db.close();
  }, 30_000);
});
