import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChangeType, PatientAlert, PatientMessage } from "./contract";
import { displayDrugName } from "./display";
import { ElevenLabsClient } from "./elevenlabs";
import { GrokClient } from "./grok";

// Builds the patient-facing notification for one alert: an englishText template built ONLY from
// our own data (never an LLM -- the core rule of this app applies to money as much as to coverage
// decisions), then optionally translated into the patient's language (Grok) and read aloud
// (ElevenLabs). If translation changes any number, we fall back to English rather than risk a
// patient reading a wrong dollar amount.

const money = (n: number | null): string => (n === null ? "" : `$${n.toFixed(2)}`);

const CHANGE_LABEL: Record<ChangeType, string> = {
  removed: "will no longer be covered",
  tier_increase: "is moving to a higher cost tier",
  new_prior_auth: "will now require prior authorization",
  new_step_therapy: "will now require step therapy (trying another drug first)",
  new_quantity_limit: "will now have a quantity limit",
};

/** Deterministic template: drug names, costs, dates and the alternative all come from `alert` only. */
export function buildEnglishText(alert: PatientAlert): string {
  const drug = alert.displayName || alert.drugName;
  const parts: string[] = [`Starting ${alert.effectiveDate}, your Medicare Part D plan says ${drug} ${CHANGE_LABEL[alert.changeType]}.`];

  if (alert.changeType === "removed") {
    if (alert.oldMonthlyCost !== null) parts.push(`You were paying about ${money(alert.oldMonthlyCost)} per month for it.`);
  } else if (alert.oldMonthlyCost !== null && alert.newMonthlyCost !== null) {
    if (alert.newMonthlyCost > alert.oldMonthlyCost) {
      parts.push(`Your estimated monthly cost is going from ${money(alert.oldMonthlyCost)} to ${money(alert.newMonthlyCost)}.`);
    } else {
      parts.push(`Your estimated monthly cost is currently about ${money(alert.oldMonthlyCost)}.`);
    }
  }

  if (alert.bestAlternative) {
    const alt = alert.bestAlternative;
    const altName = displayDrugName(alt.drugName);
    parts.push(
      `A covered alternative, ${altName}, is available for about ${money(alt.estMonthlyCost)} per month` +
        (alt.monthlySavings > 0 ? `, which could save you about ${money(alt.monthlySavings)} per month.` : "."),
    );
  } else {
    parts.push("Please contact your doctor's office to discuss a covered alternative.");
  }

  parts.push("Do not stop taking any medication without talking to your doctor first.");
  return parts.join(" ");
}

/** All digit runs in order (money/percent/date components); translation must preserve these exactly. */
export function extractNumbers(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

export function numbersMatch(a: string, b: string): boolean {
  const na = extractNumbers(a).sort();
  const nb = extractNumbers(b).sort();
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

export interface BuildMessageOptions {
  grok?: GrokClient;
  elevenLabs?: ElevenLabsClient;
  /** Where to save the mp3 (default public/audio). */
  audioDir?: string;
  /** URL prefix the saved file is served under (default /audio, matching Next's /public convention). */
  publicPath?: string;
}

/**
 * Builds the full PatientMessage: englishText (always), translated `text` (skipped -- English is
 * used as-is -- when the patient's language already is English), and a saved mp3.
 * Never sets the alert's status; the route does that after this succeeds.
 */
export async function buildPatientMessage(alert: PatientAlert, opts: BuildMessageOptions = {}): Promise<PatientMessage> {
  const englishText = buildEnglishText(alert);
  const isEnglish = alert.language.trim().toLowerCase() === "english";

  let text = englishText;
  let language = "English";
  if (!isEnglish) {
    const grok = opts.grok ?? new GrokClient();
    const translated = await grok.translate(englishText, alert.language);
    if (numbersMatch(englishText, translated)) {
      text = translated;
      language = alert.language;
    } else {
      console.warn(`message: translation for alert ${alert.id} changed a number; falling back to English`);
    }
  }

  const elevenLabs = opts.elevenLabs ?? new ElevenLabsClient();
  const audio = await elevenLabs.synthesize(text);

  const audioDir = opts.audioDir ?? path.join(process.cwd(), "public", "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const filename = `${alert.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomBytes(4).toString("hex")}.mp3`;
  fs.writeFileSync(path.join(audioDir, filename), audio);

  const publicPath = opts.publicPath ?? "/audio";
  return { alertId: alert.id, language, text, englishText, audioUrl: `${publicPath}/${filename}` };
}
