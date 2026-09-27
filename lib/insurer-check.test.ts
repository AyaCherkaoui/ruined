import { beforeEach, describe, expect, it } from "vitest";
import type { CoverageResult, InsurerCheck } from "./contract";
import { compareWithCms } from "./insurer-compare";
import { clearHumanaCache, humanaCheck, humanaPlanYearId, insurerForPlan, parseHumanaRecord } from "./insurer-check";

const EXT = "http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition";

function record(planYearId: string, opts: { tier?: string; label?: string; pa?: boolean; ql?: boolean } = {}) {
  return {
    resourceType: "MedicationKnowledge",
    meta: { lastUpdated: "2026-06-10T21:00:16.000+00:00" },
    code: { coding: [{ system: "https://fhir.humana.com/documentation/glossary/ndc11", code: "00169431430", display: "Rybelsus 14 mg tablet" }] },
    extension: [
      { url: `${EXT}/usdf-DrugTierID-extension`, valueCodeableConcept: { coding: [{ code: opts.tier ?? "3", display: opts.label ?? "Preferred Brand" }] } },
      { url: `${EXT}/usdf-PriorAuthorization-extension`, valueBoolean: opts.pa ?? true },
      { url: `${EXT}/usdf-StepTherapyLimit-extension`, valueBoolean: null },
      { url: `${EXT}/usdf-QuantityLimit-extension`, valueBoolean: opts.ql ?? false },
      { url: `${EXT}/usdf-PlanID-extension`, valueString: planYearId },
    ],
  };
}

/** Fake Humana server: `total` records for one NDC, 100 per page, paged with _skip. */
function fakeHumana(records: ReturnType<typeof record>[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const skip = Number(url.searchParams.get("_skip") ?? 0);
    const count = Number(url.searchParams.get("_count") ?? 100);
    const page = records.slice(skip, skip + count).map((resource) => ({ resource }));
    return new Response(JSON.stringify({ resourceType: "Bundle", total: records.length, entry: page }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PLAN = { contractId: "H4141", planId: "003", segmentId: "000" };

describe("Humana formulary API", () => {
  beforeEach(() => clearHumanaCache());

  it("recognizes Humana plans by name only", () => {
    expect(insurerForPlan("Humana Gold Plus SNP-DE H4141-003 (HMO D-SNP)")).toBe("Humana");
    expect(insurerForPlan("Wellcare Simple Open (PPO)")).toBeNull();
    expect(humanaPlanYearId(PLAN, 2026)).toBe("H4141-003-000-2026");
  });

  it("parses tier, restrictions and update date from a MedicationKnowledge record", () => {
    expect(parseHumanaRecord(record("H4141-003-000-2026"))).toEqual({
      planYearId: "H4141-003-000-2026",
      ndc: "00169431430",
      productName: "Rybelsus 14 mg tablet",
      tier: 3,
      tierLabel: "Preferred Brand",
      priorAuth: true,
      stepTherapy: false,
      quantityLimit: false,
      lastUpdated: "2026-06-10T21:00:16.000+00:00",
    });
    expect(parseHumanaRecord({ extension: [] })).toBeNull();
  });

  it("pages through every record and matches the plan for the right year", async () => {
    const filler = Array.from({ length: 250 }, (_, i) => record(`H9999-${String(i).padStart(3, "0")}-000-2026`));
    const { fetchImpl, calls } = fakeHumana([
      ...filler,
      record("H4141-003-000-2025", { tier: "2", label: "Generic" }),
      record("H4141-003-000-2026", { ql: true }),
    ]);
    const result = await humanaCheck(PLAN, ["00169431430"], { fetch: fetchImpl, year: 2026 });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ status: "listed", planYearId: "H4141-003-000-2026", tier: 3, priorAuth: true, quantityLimit: true });
  });

  it("reports not_listed when no record matches this plan and year", async () => {
    const { fetchImpl } = fakeHumana([record("H4141-003-000-2025")]);
    const result = await humanaCheck(PLAN, ["00169431430"], { fetch: fetchImpl, year: 2026 });
    expect(result).toMatchObject({ status: "not_listed", planYearId: "H4141-003-000-2026", ndcsChecked: ["00169431430"] });
  });

  it("reports unavailable instead of throwing when Humana errors", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const result = await humanaCheck(PLAN, ["00169431430"], { fetch: fetchImpl });
    expect(result).toMatchObject({ status: "unavailable", error: "Humana API returned 503" });
  });
});

describe("compareWithCms", () => {
  const cms = (over: Partial<CoverageResult>): CoverageResult => ({
    rxcui: "2200650",
    drugName: "semaglutide 14 MG Oral Tablet [Rybelsus]",
    status: "restricted",
    tier: 3,
    priorAuth: true,
    stepTherapy: false,
    quantityLimit: false,
    estMonthlyCost: 47,
    isEstimate: true,
    ...over,
  });
  const listed: InsurerCheck = {
    status: "listed",
    insurer: "Humana",
    planYearId: "H4141-003-000-2026",
    ndc: "00169431430",
    productName: "Rybelsus 14 mg tablet",
    tier: 3,
    tierLabel: "Preferred Brand",
    priorAuth: true,
    stepTherapy: false,
    quantityLimit: false,
    lastUpdated: null,
    source: "Humana",
    sourceUrl: "https://example.test",
  };

  it("agrees when tier and restrictions match", () => {
    expect(compareWithCms(cms({}), listed)).toEqual({ agrees: true, notes: ["Matches CMS: same tier and restrictions."] });
  });

  it("flags a drug CMS dropped that the insurer still lists", () => {
    expect(compareWithCms(cms({ status: "not_covered", tier: null }), listed)?.agrees).toBe(false);
  });

  it("flags tier and restriction differences", () => {
    const result = compareWithCms(cms({ tier: 4, priorAuth: false }), listed);
    expect(result?.agrees).toBe(false);
    expect(result?.notes).toEqual([
      "Tier differs: CMS tier 4, Humana tier 3.",
      "Restrictions differ: CMS none; Humana prior auth.",
    ]);
  });

  it("has nothing to compare for unsupported insurers", () => {
    expect(compareWithCms(cms({}), { status: "unsupported", planName: "Wellcare Simple Open (PPO)" })).toBeNull();
  });
});
