import { beforeEach, describe, expect, it } from "vitest";
import {
  createPatientMessage,
  dismissAlert,
  emailDigest,
  getDigest,
  getUpcoming,
  resetDemo,
  searchDrugs,
  searchPatients,
  switchAlert,
} from "./api";

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

describe("alert inbox mocks", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("lists the synthetic tier changes and two CMS alerts", async () => {
    const digest = await getDigest();
    expect(digest.totalAtRisk).toBe(5);
    expect(digest.totalMonthlyIncrease).toBe(206.33);
    expect(digest.totalMonthlySavingsIfSwitched).toBe(291.54);
    expect(digest.alerts.map((row) => row.id)).toEqual([
      "al-evelyn-myrbetriq",
      "al-harold-tradjenta",
      "al-james-toujeo",
      "al-patricia-gabapentin",
      "al-hyunwoo-rosuvastatin",
    ]);

    expect(digest.alerts[0]).toMatchObject({
      patientName: "Evelyn Park",
      age: 83,
      language: "Korean",
      planName: "Humana Basic Rx",
      displayName: "Myrbetriq",
      changeType: "tier_increase",
      oldTier: 3,
      newTier: 4,
      oldMonthlyCost: 110.49,
      newMonthlyCost: 150.27,
      dataSource: "synthetic",
      status: "new",
    });
    expect(digest.alerts[0].bestAlternative).toMatchObject({ rxcui: "857560", estMonthlyCost: 9.32, monthlySavings: 140.95 });
    expect(digest.alerts[0].bestAlternative?.drugName).toContain("trospium");

    expect(digest.alerts[1].bestAlternative).toMatchObject({ estMonthlyCost: 29.31, monthlySavings: 142.25 });
    expect(digest.alerts[1].bestAlternative?.drugName).toContain("Januvia");
    expect(digest.alerts[2]).toMatchObject({
      patientName: "James Carter",
      displayName: "Toujeo",
      oldMonthlyCost: 274.82,
      newMonthlyCost: 373.75,
      bestAlternative: null,
      dataSource: "synthetic",
    });

    const cms = digest.alerts.filter((row) => row.dataSource === "cms");
    expect(cms.map((row) => row.changeType).sort()).toEqual(["new_prior_auth", "removed"]);
    expect(cms.find((row) => row.changeType === "removed")).toMatchObject({
      displayName: "gabapentin",
      bestAlternative: null,
    });
    expect(cms.find((row) => row.changeType === "new_prior_auth")?.drugName.toLowerCase()).toContain("rosuvastatin");
  });

  it("updates the digest when a switch, a message, or a dismiss is recorded", async () => {
    const switched = await switchAlert("al-evelyn-myrbetriq", "857560");
    expect(switched).toMatchObject({ status: "switched", switchedTo: "857560" });

    let digest = await getDigest();
    expect(digest.totalAtRisk).toBe(4);
    expect(digest.totalMonthlyIncrease).toBe(166.55);
    expect(digest.totalMonthlySavingsIfSwitched).toBe(150.59);

    const message = await createPatientMessage("al-evelyn-myrbetriq");
    expect(message).toMatchObject({
      alertId: "al-evelyn-myrbetriq",
      language: "Korean",
      audioUrl: null,
    });
    expect(message.text).toMatch(/[가-힣]/);
    expect(message.text).toContain("est. $110.49");
    expect(message.text).toContain("est. $9.32");
    expect(message.englishText).toContain("Evelyn");
    expect(message.englishText).toContain("est. $150.27");
    expect(message.englishText).toContain("trospium");
    expect(message.text).not.toBe(message.englishText);

    digest = await getDigest();
    expect(digest.alerts.find((row) => row.id === "al-evelyn-myrbetriq")?.status).toBe("patient_notified");
    expect(digest.totalAtRisk).toBe(4);

    const again = await createPatientMessage("al-evelyn-myrbetriq");
    expect(again.text).toBe(message.text);

    await dismissAlert("al-james-toujeo");
    digest = await getDigest();
    expect(digest.totalAtRisk).toBe(3);
    expect(digest.alerts.find((row) => row.id === "al-james-toujeo")?.status).toBe("dismissed");
    expect(digest.totalMonthlyIncrease).toBe(67.62);

    await expect(switchAlert("missing", "1")).rejects.toThrow(/not found/i);
    await expect(emailDigest()).resolves.toEqual({ sent: true });
  });

  it("restores the inbox after a reset", async () => {
    await dismissAlert("al-harold-tradjenta");
    await switchAlert("al-james-toujeo", "2002420");
    await resetDemo();
    const digest = await getDigest();
    expect(digest.totalAtRisk).toBe(5);
    expect(digest.alerts.every((row) => row.status === "new" && row.switchedTo === null)).toBe(true);
  });
});
