import { timingSafeEqual } from "node:crypto";
import { getAlert } from "./coverageAlerts";
import { ApiError } from "./http";
import { buildSms, type SmsResult } from "./sms";
import { liveSmsConfigured, sendSms } from "./twilio";

// Demo-only, process-local state, matching the coverage-alert store. It is not a
// durable delivery guarantee across restarts or multiple server instances.
const globalSms = globalThis as unknown as { __smsNotifications?: Map<string, Promise<SmsResult>> };
function notifications() { return globalSms.__smsNotifications ??= new Map(); }

export function authorizeSms(request: Request) {
  const expected = process.env.SMS_SEND_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    throw new ApiError(401, "A valid messaging access key is required to send texts.");
  }
}

export async function notifyAlert(id: string, preview: boolean): Promise<SmsResult> {
  const alert = await getAlert(id);
  if (alert.status !== "open") throw new ApiError(409, "This alert is already resolved.");
  let body: string;
  try { body = buildSms(process.env.APP_URL, alert.isDemo); }
  catch { throw new ApiError(503, "Check the configured app URL before previewing or sending texts."); }
  if (preview || !liveSmsConfigured()) return { mode: "preview", status: "preview", body };
  const entries = notifications();
  const existing = entries.get(id);
  if (existing) return existing;
  const pending = sendSms(body);
  entries.set(id, pending);
  const result = await pending;
  // Hold accepted and uncertain results to prevent accidental repeat sends.
  if (result.status === "failed") entries.delete(id);
  return result;
}
