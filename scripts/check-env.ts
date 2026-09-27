import { loadEnvConfig } from "@next/env";
import { existsSync, statSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";

// Print only names and validation results; never print keys, tokens, or recipients.
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const env = process.env;
let failures = 0;
function check(label: string, valid: boolean, fix: string) {
  console.log(`${valid ? "OK" : "FIX"} ${label}${valid ? "" : `: ${fix}`}`);
  if (!valid) failures++;
}
function httpUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value || "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
const app = httpUrl(env.APP_URL);
check("APP_URL", Boolean(app), "Set the app's full HTTP(S) URL.");
const supabase = httpUrl(env.NEXT_PUBLIC_SUPABASE_URL);
check("NEXT_PUBLIC_SUPABASE_URL", supabase?.origin === "https://aubtnsvksswxpghmamuu.supabase.co", "Use the HeadsUp Supabase project URL from docs/environment.md.");
const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
check("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", Boolean(key?.startsWith("sb_publishable_")), "Use the publishable key from the same project; never a secret/service-role key.");
check("COVERAGE_ALERTS_SOURCE", !env.COVERAGE_ALERTS_SOURCE || env.COVERAGE_ALERTS_SOURCE === "supabase", "Use supabase or leave unset for this deployment.");
check("MESSAGING_CHANNEL", env.MESSAGING_CHANNEL === "whatsapp", "Set whatsapp for this demo.");
check("SMS_MODE", ["preview", "live"].includes(env.SMS_MODE || ""), "Choose preview or live.");
if (env.SMS_MODE === "live") {
  check("TWILIO_ACCOUNT_SID", /^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID || ""), "Copy the account SID from the working local configuration.");
  check("TWILIO_AUTH_TOKEN", Boolean(env.TWILIO_AUTH_TOKEN?.trim()), "Set the token belonging to that account.");
  for (const name of ["TWILIO_WHATSAPP_FROM", "DOCTOR_PHONE"]) {
    check(name, /^(whatsapp:)?\+[1-9]\d{7,14}$/.test(env[name]?.trim() || ""), "Use an international +country-code number; whatsapp: prefix is allowed.");
  }
  check("SMS_SEND_TOKEN", Boolean(env.SMS_SEND_TOKEN?.trim()), "Copy the server-only messaging access key; do not use a NEXT_PUBLIC_ prefix.");
  check("APP_URL for live messages", Boolean(app && app.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(app.hostname)), "Use https://headsuphealth.tech for the hosted demo.");
}
check("PATIENT_DATA_SOURCE", !env.PATIENT_DATA_SOURCE || ["supabase", "local"].includes(env.PATIENT_DATA_SOURCE), "Use supabase (default) or local.");
if (env.PATIENT_DATA_SOURCE === "local") {
  const file = resolve(env.RUINED_DB || "data/scenario.duckdb");
  const present = existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
  check("RUINED_DB patient database", present, "Local mode needs a populated, writable scenario.duckdb file.");
  if (present) {
    let writable = false;
    try { accessSync(file, constants.R_OK | constants.W_OK); writable = true; } catch { /* reported below */ }
    check("Patient database permissions", writable, "The app needs read/write access for decisions and notification receipts.");
  }
} else {
  console.log("OK Patient dashboard uses Supabase; local DuckDB storage is not required.");
}
console.log("Checks validate local settings and file presence, not remote deployment, schema contents, Sandbox membership, or delivery.");
console.log("Public Supabase settings must be present when building. Rebuild/redeploy after changing them.");
process.exitCode = failures ? 1 : 0;
