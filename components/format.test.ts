import { describe, expect, it } from "vitest";
import { alertSentence, chartLabel, displayDrugName, estMoney } from "./format";

describe("displayDrugName", () => {
  it("uses the brand in brackets", () => {
    expect(
      displayDrugName("24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]"),
    ).toBe("Myrbetriq");
    expect(
      displayDrugName("0.25 MG, 0.5 MG Dose 3 ML semaglutide 0.68 MG/ML Pen Injector [Ozempic]"),
    ).toBe("Ozempic");
  });

  it("uses the first few words when there is no brand", () => {
    expect(displayDrugName("lisinopril 20 MG Oral Tablet")).toBe("lisinopril 20 MG");
  });
});

describe("estMoney", () => {
  it("labels every amount as an estimate", () => {
    expect(estMoney(110.49)).toBe("est. $110.49");
    expect(estMoney(0)).toBe("est. $0.00");
    expect(estMoney(null)).toBe("est. —");
  });
});

describe("alertSentence", () => {
  it("reads as a coverage change for the patient", () => {
    expect(
      alertSentence({
        patientName: "Evelyn Park",
        drugName: "24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]",
        oldMonthlyCost: 110.49,
        newMonthlyCost: 150.27,
      }),
    ).toBe("Evelyn Park's Myrbetriq went from est. $110.49 to est. $150.27/month");
  });
});

describe("chartLabel", () => {
  it("shortens unique first names and keeps full names when they collide", () => {
    expect(chartLabel("Evelyn Park", ["Evelyn Park", "James Carter"])).toBe("Evelyn");
    expect(chartLabel("Evelyn Park", ["Evelyn Park", "Evelyn Cho"])).toBe("Evelyn Park");
  });
});
