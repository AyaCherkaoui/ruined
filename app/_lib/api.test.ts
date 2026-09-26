import { describe, expect, it } from "vitest";
import { getUpcoming, searchDrugs, searchPatients } from "./api";

describe("mock patient and drug search", () => {
  it("finds Evelyn Park with age, language, and plan", async () => {
    const [evelyn] = await searchPatients("evelyn park");
    expect(evelyn).toMatchObject({
      id: "pt-007",
      name: "Evelyn Park",
      age: 83,
      language: "Korean",
      plan: { planName: "Humana Basic Rx Plan (PDP)" },
    });
  });

  it("limits medication search to the selected patient", async () => {
    const drugs = await searchDrugs("pt-007", "");
    expect(drugs.map((drug) => drug.rxcui).sort()).toEqual(["1300803", "197361", "966247"]);
    expect(await searchDrugs("pt-007", "myrbetriq")).toEqual([
      {
        rxcui: "1300803",
        drugName: "24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]",
        displayName: "Myrbetriq",
      },
    ]);
    expect(await searchDrugs("pt-007", "toujeo")).toEqual([]);
    expect(await searchDrugs("pt-999", "metformin")).toEqual([]);
  });

  it("lists the three upcoming plan changes", async () => {
    const rows = await getUpcoming();
    expect(rows.map((row) => [row.patientId, row.displayName, row.oldMonthlyCost, row.newMonthlyCost])).toEqual([
      ["pt-007", "Myrbetriq", 110.49, 150.27],
      ["pt-006", "Toujeo", 274.82, 373.75],
      ["pt-004", "Tradjenta", 126.14, 171.56],
    ]);
    expect(rows[0]).toMatchObject({
      patientName: "Evelyn Park",
      age: 83,
      language: "Korean",
      rxcui: "1300803",
      percentIncrease: 36,
      effectiveDate: "2027-01-01",
    });
    expect(rows[0].bestAlternative).toMatchObject({
      rxcui: "857560",
      estMonthlyCost: 9.32,
      monthlySavings: 101.17,
    });
    expect(rows[0].bestAlternative?.drugName).toContain("trospium");
    expect(rows[1].bestAlternative).toBeNull();
    expect(rows[2].bestAlternative).toMatchObject({ estMonthlyCost: 29.31, monthlySavings: 96.83 });
    expect(rows[2].bestAlternative?.drugName).toContain("Januvia");
  });
});
