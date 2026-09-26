import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classAllowsAlternatives, compareAlternatives, findAlternatives, MAX_ALTERNATIVES } from "./alternatives";
import { checkCoverage, coverageForRxcuis, isSpecialtyTier, loadPlanContext, round2 } from "./coverage";
import { dbPath, openDb, type Db } from "./db";

// findAlternatives against the real CMS Q2 2026 Georgia data (data_version 'v1').
// Pinned numbers were verified independently in Python from the raw tables.

const hasDb = fs.existsSync(dbPath());

const HUMANA_BASIC = { contractId: "S5884", planId: "135", segmentId: "000" }; // 25% coinsurance on tier 3
const AARP_PREFERRED = { contractId: "S5921", planId: "392", segmentId: "000" };
const HEALTHSPRING = { contractId: "H0439", planId: "006", segmentId: "000" };

describe.skipIf(!hasDb)("findAlternatives on real Georgia plans", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ readOnly: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it("brand -> its exact generic: Synthroid 50 mcg ($12.56, tier 3) -> generic levothyroxine (tier 1, $0)", async () => {
    const [alt, ...rest] = await findAlternatives(HUMANA_BASIC, "966247", { db });
    expect(rest).toEqual([]);
    expect(alt).toEqual({
      rxcui: "966221",
      drugName: "levothyroxine sodium 0.05 MG Oral Tablet",
      status: "covered",
      tier: 1,
      priorAuth: false,
      stepTherapy: false,
      quantityLimit: false,
      estMonthlyCost: 0,
      isEstimate: true,
      monthlySavings: 12.56,
    });
  });

  it("class-level swap inside an interchangeable class: Jardiance -> dapagliflozin (SGLT2), small but real saving", async () => {
    const alts = await findAlternatives(HUMANA_BASIC, "1545664", { db }); // empagliflozin 10 MG [Jardiance], $50.96
    expect(alts).toHaveLength(1);
    expect(alts[0].drugName).toContain("dapagliflozin");
    expect(alts[0].estMonthlyCost).toBeCloseTo(45.4, 2);
    expect(alts[0].monthlySavings).toBeCloseTo(5.56, 2);
  });

  it("returns nothing when nothing is genuinely cheaper (Ozempic on a plan that does not cover Trulicity)", async () => {
    expect(await findAlternatives(HUMANA_BASIC, "2619154", { db })).toEqual([]);
  });

  it("never suggests a swap for a specialty-tier, non-interchangeable drug (Exxua, tier 5)", async () => {
    expect(await findAlternatives(HEALTHSPRING, "2672379", { db })).toEqual([]);
  });

  it("never suggests a swap for oncology drugs (Xtandi, an ATC L class)", async () => {
    expect(await findAlternatives(HEALTHSPRING, "2390646", { db })).toEqual([]);
  });

  it("returns [] for a drug it knows nothing about", async () => {
    expect(await findAlternatives(HEALTHSPRING, "999999999", { db })).toEqual([]);
  });

  // The rules, checked against ~300 real drugs on two different plans (every 12th classed drug on each formulary).
  for (const plan of [HUMANA_BASIC, AARP_PREFERRED]) {
    it(`every suggestion on ${plan.contractId}-${plan.planId} obeys the rules (property test)`, { timeout: 120_000 }, async () => {
      const ctx = await loadPlanContext(db, plan);
      const drugs = await db.query<{
        rxcui: string;
        tty: string;
        class_id: string | null;
        ingredient_rxcui: string | null;
        dose_form_group: string | null;
        generic_rxcui: string | null;
      }>(
        `SELECT DISTINCT d.rxcui, d.tty, d.class_id, d.ingredient_rxcui, d.dose_form_group, d.generic_rxcui
           FROM formulary f JOIN drugs d ON d.rxcui = f.rxcui
          WHERE f.data_version = 'v1' AND f.formulary_id = $1 AND d.class_id IS NOT NULL AND d.tty IN ('SCD', 'SBD')
          ORDER BY d.rxcui`,
        [ctx.formularyId],
      );
      const byRxcui = new Map(
        (await db.query<{ rxcui: string; tty: string; class_id: string | null; ingredient_rxcui: string | null; dose_form_group: string | null }>(
          "SELECT rxcui, tty, class_id, ingredient_rxcui, dose_form_group FROM drugs",
        )).map((d) => [d.rxcui, d]),
      );
      const sample = drugs.filter((_, i) => i % 12 === 0);
      expect(sample.length).toBeGreaterThan(100);

      const sourceCoverage = await coverageForRxcuis(db, ctx, sample.map((d) => d.rxcui));
      let withAlternatives = 0;
      for (const source of sample) {
        const alts = await findAlternatives(plan, source.rxcui, { db });
        if (alts.length === 0) continue;
        withAlternatives++;
        const sourceCost = sourceCoverage.get(source.rxcui)!.estMonthlyCost!;

        expect(alts.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
        expect([...alts].sort(compareAlternatives).map((a) => a.rxcui)).toEqual(alts.map((a) => a.rxcui)); // ranked
        expect(new Set(alts.map((a) => byRxcui.get(a.rxcui)?.ingredient_rxcui ?? a.rxcui)).size).toBe(alts.length); // one per ingredient

        for (const alt of alts) {
          const d = byRxcui.get(alt.rxcui)!;
          expect(alt.rxcui).not.toBe(source.rxcui);
          expect(alt.status).not.toBe("not_covered");
          expect(alt.estMonthlyCost).not.toBeNull();
          expect(alt.isEstimate).toBe(true);
          expect(["SCD", "SBD"]).toContain(d.tty); // never a starter pack / kit
          expect(alt.monthlySavings).toBeGreaterThan(0); // "cheaper" only
          expect(alt.monthlySavings).toBe(round2(sourceCost - alt.estMonthlyCost!));

          if (alt.rxcui === source.generic_rxcui) continue; // exact generic equivalent: exempt from class guardrails
          expect(source.class_id && classAllowsAlternatives(source.class_id)).toBe(true);
          expect(d.class_id).toBe(source.class_id);
          expect(d.ingredient_rxcui).not.toBe(source.ingredient_rxcui);
          expect(d.dose_form_group).toBe(source.dose_form_group);
          expect(isSpecialtyTier(ctx, sourceCoverage.get(source.rxcui)!.tier)).toBe(false);
          expect(isSpecialtyTier(ctx, alt.tier)).toBe(false);
        }
      }
      // the rules must not be so strict that the feature never fires
      expect(withAlternatives).toBeGreaterThan(5);
    });
  }

  it("agrees with checkCoverage for the same drug (consistent numbers across the API)", async () => {
    const [alt] = await findAlternatives(HUMANA_BASIC, "966247", { db });
    const direct = await checkCoverage("S5884", "135", "000", alt.rxcui, { db });
    const coverage = Object.fromEntries(Object.entries(alt).filter(([key]) => key !== "monthlySavings"));
    expect(coverage).toEqual(direct);
  });
});
