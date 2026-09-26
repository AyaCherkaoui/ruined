import { describe, expect, it } from "vitest";
import type { Digest, PatientAlert } from "./contract";
import { digestHtml, digestSubject, sendDigestEmail } from "./digestEmail";
import { MissingApiKeyError } from "./http";
import { FROM_ADDRESS, ResendClient } from "./resend";

const alertWithAlt: PatientAlert = {
  id: "pt-1:1:tier_increase",
  patientId: "pt-1",
  patientName: "Ann O'Brien", // apostrophe: must not break the HTML
  age: 70,
  language: "English",
  planName: "Test Plan",
  rxcui: "1",
  drugName: "drug one",
  displayName: "DrugOne",
  changeType: "tier_increase",
  oldTier: 2,
  newTier: 3,
  oldMonthlyCost: 10,
  newMonthlyCost: 75,
  monthlyIncrease: 65,
  percentIncrease: 650,
  effectiveDate: "2026-09-01",
  dataSource: "cms",
  bestAlternative: { rxcui: "2", drugName: "drug two <brand>", status: "covered", tier: 1, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: 5, isEstimate: true, monthlySavings: 70 },
  status: "new",
  switchedTo: null,
};

const alertNoAlt: PatientAlert = {
  ...alertWithAlt,
  id: "pt-2:2:removed",
  patientId: "pt-2",
  patientName: "Bea & Co",
  changeType: "removed",
  newTier: null,
  newMonthlyCost: null,
  monthlyIncrease: null,
  percentIncrease: null,
  bestAlternative: null,
};

const DIGEST: Digest = {
  totalAtRisk: 2,
  totalMonthlyIncrease: 65,
  totalMonthlySavingsIfSwitched: 70,
  alerts: [alertWithAlt, alertNoAlt],
  generatedAt: "2026-09-26T12:00:00.000Z",
};

describe("digestSubject", () => {
  it("names the count of at-risk patients", () => {
    expect(digestSubject(DIGEST)).toBe("2 of your patients are affected by upcoming plan changes");
    expect(digestSubject({ ...DIGEST, totalAtRisk: 0 })).toBe("0 of your patients are affected by upcoming plan changes");
  });
});

describe("digestHtml", () => {
  it("includes each alert's patient, drug, before/after cost, suggested switch and savings", () => {
    const html = digestHtml(DIGEST);
    expect(html).toContain("Ann O'Brien");
    expect(html).toContain("DrugOne");
    expect(html).toContain("$10.00");
    expect(html).toContain("$75.00");
    expect(html).toContain("$70.00"); // savings
    expect(html).toContain("$65.00"); // totalMonthlyIncrease
  });

  it("shows an em dash, not 'null', for an alert with no alternative or no new cost", () => {
    const html = digestHtml(DIGEST);
    // Bea's row: removed, no alternative -- cost-after and switch/savings columns show em dashes
    expect(html).not.toContain("null");
    expect(html).toContain("—");
  });

  it("escapes HTML special characters in patient/drug names (never raw-injects them)", () => {
    const html = digestHtml(DIGEST);
    expect(html).toContain("Bea &amp; Co");
    expect(html).not.toMatch(/[^;]Bea & Co/); // raw & (not part of an entity) would break the markup
    expect(html).toContain("drug two &lt;brand&gt;");
    expect(html).not.toContain("<brand>");
  });
});

describe("sendDigestEmail", () => {
  it("throws MissingApiKeyError when DOCTOR_EMAIL isn't configured", async () => {
    await expect(sendDigestEmail(DIGEST, { to: undefined, resend: new ResendClient({ apiKey: "x" }) })).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("sends the digest as HTML to the given address and returns { sent: true, id }", async () => {
    const calls: unknown[] = [];
    const resend = new ResendClient({
      apiKey: "test-key",
      fetch: (async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ id: "email_abc" }));
      }) as unknown as typeof fetch,
    });

    const result = await sendDigestEmail(DIGEST, { to: "doctor@example.com", resend });
    expect(result).toEqual({ sent: true, id: "email_abc" });

    const sent = calls[0] as { from: string; to: string[]; subject: string; html: string };
    expect(sent.from).toBe(FROM_ADDRESS);
    expect(sent.to).toEqual(["doctor@example.com"]);
    expect(sent.subject).toBe(digestSubject(DIGEST));
    expect(sent.html).toContain("DrugOne");
  });
});
