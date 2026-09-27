import { loadEnvConfig } from "@next/env";
import { readFile, writeFile } from "node:fs/promises";
import { openDb } from "../lib/db";
import { liveSmsConfigured, sendSms, type SmsEnvironment } from "../lib/twilio";

// No secrets, phone numbers, or patient records are written to this ignored receipt.
const receiptPath = ".env.whatsapp-test-receipt.json";

async function main() {
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  const env: SmsEnvironment = { ...process.env, MESSAGING_CHANNEL: "whatsapp", SMS_MODE: "live" };
  const args = process.argv.slice(2);
  const credentials = () => ({ Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}` });
  if (args.includes("--status")) {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { sid?: string };
    if (!receipt.sid || !/^SM[0-9a-f]{32}$/i.test(receipt.sid)) throw new Error("No valid message receipt.");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${receipt.sid}.json`, {
      headers: credentials(), signal: AbortSignal.timeout(10000), redirect: "error",
    });
    const data = await response.json();
    console.log(JSON.stringify({ httpStatus: response.status, deliveryStatus: data.status, errorCode: data.error_code ?? data.code }));
    if (!response.ok || ["failed", "undelivered"].includes(data.status)) process.exitCode = 1;
    return;
  }

  const db = await openDb({ readOnly: true });
  let count: number;
  try {
    const [row] = await db.query<{ count: number }>("SELECT COUNT(DISTINCT a.patient_id) AS count FROM patient_alerts a JOIN prescriptions p ON p.id = a.prescription_id WHERE p.doctor_id = 'doc-001'");
    count = row.count;
  } finally { await db.close(); }
  const body = `HeadsUp demo: ${count} patients were affected by an insurance change. View details: https://example.com/coverage-alerts`;
  console.log(JSON.stringify({ body, recipientSuffix: env.DOCTOR_PHONE?.slice(-4), configured: liveSmsConfigured(env) }));
  if (!args.includes("--send")) return;
  if (!liveSmsConfigured(env)) throw new Error("WhatsApp configuration is incomplete.");

  // Preserve uncertain/accepted attempts across command invocations to avoid duplicates.
  const previous = await readFile(receiptPath, "utf8").then(text => JSON.parse(text)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous && previous.status !== "failed") throw new Error("An earlier send may have succeeded; use --status before another attempt.");
  await writeFile(receiptPath, JSON.stringify({ status: "unknown", attemptedAt: new Date().toISOString() }));
  let sid: string | undefined;
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const data = await response.clone().json().catch(() => ({}));
    sid = data.sid;
    console.log(JSON.stringify({ httpStatus: response.status, providerStatus: data.status, errorCode: data.code }));
    return response;
  };
  const result = await sendSms(body, env, request);
  await writeFile(receiptPath, JSON.stringify({ sid, status: result.status, attemptedAt: new Date().toISOString() }));
  console.log(JSON.stringify(result));
  if (result.status !== "accepted") process.exitCode = 1;
}

main().catch(() => {
  console.error("WhatsApp test stopped. Check configuration and any existing .env.whatsapp-test-receipt.json; do not repeat uncertain sends. Use --status for a saved message.");
  process.exitCode = 1;
});
