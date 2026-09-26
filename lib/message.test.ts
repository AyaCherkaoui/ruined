import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PatientAlert } from "./contract";
import { ElevenLabsClient } from "./elevenlabs";
import { GrokClient } from "./grok";
import { buildEnglishText, buildPatientMessage, extractNumbers, numbersMatch } from "./message";

const BASE: PatientAlert = {
  id: "pt-1:111:removed",
  patientId: "pt-1",
  patientName: "Ann",
  age: 70,
  language: "English",
  planName: "Test Plan",
  rxcui: "111",
  drugName: "semaglutide 14 MG Oral Tablet [Rybelsus]",
  displayName: "Rybelsus",
  changeType: "removed",
  oldTier: 3,
  newTier: null,
  oldMonthlyCost: 238.41,
  newMonthlyCost: null,
  monthlyIncrease: null,
  percentIncrease: null,
  effectiveDate: "2026-09-01",
  dataSource: "cms",
  bestAlternative: null,
  status: "new",
  switchedTo: null,
};

describe("extractNumbers / numbersMatch", () => {
  it("extracts every digit run, ignoring surrounding words/currency/date punctuation", () => {
    expect(extractNumbers("Starting 2026-09-01, cost is $238.41 (was $47.00)")).toEqual(["2026", "09", "01", "238.41", "47.00"]);
  });

  it("matches regardless of order, but not if a digit run differs or is missing", () => {
    expect(numbersMatch("$10 and $20", "$20 y $10")).toBe(true);
    expect(numbersMatch("$10 and $20", "$15 y $10")).toBe(false);
    expect(numbersMatch("$10 and $20", "$10")).toBe(false);
  });
});

describe("buildEnglishText", () => {
  it("removed, with a known prior cost and no alternative", () => {
    const text = buildEnglishText(BASE);
    expect(text).toContain("Starting 2026-09-01");
    expect(text).toContain("Rybelsus will no longer be covered");
    expect(text).toContain("$238.41 per month");
    expect(text).toContain("contact your doctor's office to discuss a covered alternative");
    expect(text).toContain("Do not stop taking any medication");
  });

  it("removed, with an alternative available", () => {
    const withAlt: PatientAlert = {
      ...BASE,
      bestAlternative: { rxcui: "222", drugName: "generic thing [Brand]", status: "covered", tier: 1, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: 10, isEstimate: true, monthlySavings: 228.41 },
    };
    const text = buildEnglishText(withAlt);
    expect(text).toContain("A covered alternative, Brand, is available for about $10.00 per month");
    expect(text).toContain("save you about $228.41 per month");
  });

  it("tier_increase states the old and new cost", () => {
    const tierUp: PatientAlert = { ...BASE, changeType: "tier_increase", oldTier: 2, newTier: 3, oldMonthlyCost: 10, newMonthlyCost: 75, monthlyIncrease: 65 };
    const text = buildEnglishText(tierUp);
    expect(text).toContain("is moving to a higher cost tier");
    expect(text).toContain("going from $10.00 to $75.00");
  });

  it("a restriction-only change (new_prior_auth) with an unchanged cost does not claim a cost change", () => {
    const pa: PatientAlert = { ...BASE, changeType: "new_prior_auth", oldTier: 2, newTier: 2, oldMonthlyCost: 10, newMonthlyCost: 10, monthlyIncrease: 0 };
    const text = buildEnglishText(pa);
    expect(text).toContain("will now require prior authorization");
    expect(text).toContain("currently about $10.00");
    expect(text).not.toContain("going from");
  });

  it("omits the cost line entirely when cost is unknown", () => {
    const unknown: PatientAlert = { ...BASE, oldMonthlyCost: null };
    const text = buildEnglishText(unknown);
    expect(text).not.toContain("per month for it");
    expect(text).not.toContain("null");
  });

  it("every number in the text traces back to alert fields (no invented figures)", () => {
    const alt: PatientAlert = {
      ...BASE,
      changeType: "tier_increase",
      oldTier: 2,
      newTier: 3,
      oldMonthlyCost: 10,
      newMonthlyCost: 75,
      bestAlternative: { rxcui: "222", drugName: "betadrug", status: "covered", tier: 1, priorAuth: false, stepTherapy: false, quantityLimit: false, estMonthlyCost: 5, isEstimate: true, monthlySavings: 70 },
    };
    const text = buildEnglishText(alt);
    const nums = extractNumbers(text);
    expect(new Set(nums)).toEqual(new Set(["2026", "09", "01", "10.00", "75.00", "5.00", "70.00"]));
  });
});

describe("buildPatientMessage", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function tmpAudioDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruined-audio-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("an English-language patient never calls Grok, and gets englishText as text", async () => {
    const grok = new GrokClient({ apiKey: "x", fetch: (async () => { throw new Error("Grok should not be called for English"); }) as unknown as typeof fetch });
    const elevenLabs = new ElevenLabsClient({ apiKey: "x", fetch: (async () => new Response(new Uint8Array([9]))) as unknown as typeof fetch });
    const audioDir = tmpAudioDir();

    const msg = await buildPatientMessage(BASE, { grok, elevenLabs, audioDir, publicPath: "/audio" });
    expect(msg.language).toBe("English");
    expect(msg.text).toBe(msg.englishText);
    expect(msg.alertId).toBe(BASE.id);
    expect(msg.audioUrl).toMatch(/^\/audio\/.+\.mp3$/);
    expect(fs.readFileSync(path.join(audioDir, path.basename(msg.audioUrl!)))).toEqual(Buffer.from([9]));
  });

  it("a non-English patient gets the Grok translation when its numbers match the English original", async () => {
    const spanish: PatientAlert = { ...BASE, language: "Spanish" };
    const grok = new GrokClient({
      apiKey: "x",
      fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "Traduccion con $238.41 y fecha 2026-09-01" } }] }))) as unknown as typeof fetch,
    });
    const elevenLabs = new ElevenLabsClient({ apiKey: "x", fetch: (async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch });

    const msg = await buildPatientMessage(spanish, { grok, elevenLabs, audioDir: tmpAudioDir() });
    expect(msg.language).toBe("Spanish");
    expect(msg.text).toContain("Traduccion");
    expect(msg.englishText).not.toEqual(msg.text);
  });

  it("falls back to English when the translation changes a number", async () => {
    const spanish: PatientAlert = { ...BASE, language: "Spanish" };
    const grok = new GrokClient({
      apiKey: "x",
      // wrong dollar amount ($999 instead of $238.41) -- must not reach the patient
      fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "Traduccion con $999 y fecha 2026-09-01" } }] }))) as unknown as typeof fetch,
    });
    const elevenLabs = new ElevenLabsClient({ apiKey: "x", fetch: (async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch });

    const msg = await buildPatientMessage(spanish, { grok, elevenLabs, audioDir: tmpAudioDir() });
    expect(msg.language).toBe("English");
    expect(msg.text).toBe(msg.englishText);
    expect(msg.text).not.toContain("999");
  });

  it("propagates a MissingApiKeyError (as a clear error, not a crash) when a key isn't configured", async () => {
    const spanish: PatientAlert = { ...BASE, language: "Spanish" };
    const grok = new GrokClient({ apiKey: undefined });
    await expect(buildPatientMessage(spanish, { grok, audioDir: tmpAudioDir() })).rejects.toMatchObject({ name: "MissingApiKeyError", envVar: "XAI_API_KEY" });
  });
});
