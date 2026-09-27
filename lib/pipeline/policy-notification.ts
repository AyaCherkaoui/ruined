import { createHash, randomUUID } from "node:crypto";
import { getDb, inTransaction, type Db } from "../db";
import { ApiError } from "../http";
import { alertsForDoctor } from "../queries";
import { DEMO_DOCTOR_ID } from "../scenario";
import type { SmsResult } from "../sms";
import { liveSmsConfigured, sendSms, type SmsEnvironment } from "../twilio";
import { hostedDemoEnabled, hostedReadReceipt, hostedReserveReceipt, hostedWriteReceipt } from "../hostedDemo";

/** Deliberately generic: only the patient count and the app link. No insurer, drug, plan, or patient details. */
export function policyMessage(patients: number, link: string): string {
  return `HeadsUp: A coverage change affects ${patients} of your patients. Review in HeadsUp: ${link}`;
}

async function ensureOutbox(db: Db) {
  await db.run(`CREATE TABLE IF NOT EXISTS policy_notifications (
    id VARCHAR PRIMARY KEY, result VARCHAR NOT NULL, created_at TIMESTAMP NOT NULL)`);
}

/** A single digest per policy change set and recipient, retained across restarts. */
/** repeat: a fresh receipt per call, so every one-click demo alert sends a new message. */
export async function notifyPolicyChanges(preview = true, db?: Db, env: SmsEnvironment = process.env, request: typeof fetch = fetch, opts: { repeat?: boolean } = {}) {
  const hosted = !db && hostedDemoEnabled();
  const conn = hosted ? undefined : db ?? await getDb();
  const alerts = (await alertsForDoctor(DEMO_DOCTOR_ID, conn)).filter(a => a.status === "new" || a.status === "seen");
  const changeIds = [...new Set(alerts.map(a => a.changeId))].sort();
  const patients = new Set(alerts.map(a => a.patientId)).size;
  const url = new URL(env.APP_URL || "http://localhost:3000");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ApiError(503, "Configure a valid APP_URL.");
  const body = policyMessage(patients, new URL("/", url.origin).href);
  const configured = liveSmsConfigured({ ...env, MESSAGING_CHANNEL: "whatsapp" });
  const setupIssue = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? "Set APP_URL to an address reachable from the demo phone before sending." : null;
  if (preview || !patients) return { patients, changes: changeIds.length, configured, setupIssue, notification: { mode: "preview", status: "preview", body } as SmsResult };
  if (!configured) throw new ApiError(503, "Configure live WhatsApp credentials, recipient, APP_URL, and messaging access key first.");
  if (setupIssue) throw new ApiError(503, setupIssue);
  const id = createHash("sha256").update(JSON.stringify([DEMO_DOCTOR_ID, changeIds, env.TWILIO_ACCOUNT_SID, env.DOCTOR_PHONE?.replace(/^whatsapp:/, "").trim(), ...(opts.repeat ? [randomUUID()] : [])])).digest("hex");
  if (conn) await ensureOutbox(conn);
  const pending: SmsResult = { mode: "live", status: "unknown", body, error: "Send pending or uncertain. Check delivery before attempting another message." };
  const previous = hosted ? await hostedReserveReceipt(id, pending) : await inTransaction(conn!, async tx => {
    const [row] = await tx.query<{ result: string }>("SELECT result FROM policy_notifications WHERE id=$1", [id]);
    if (row) return JSON.parse(row.result) as SmsResult;
    // Reserve before network I/O. A crash or timeout must never cause an automatic resend.
    await tx.run("INSERT INTO policy_notifications VALUES ($1,$2,CURRENT_TIMESTAMP)", [id, JSON.stringify(pending)]);
    return null;
  });
  const notification = previous ?? await sendSms(body, { ...env, MESSAGING_CHANNEL: "whatsapp" }, request);
  if (!previous) {
    if (hosted) await hostedWriteReceipt(id, notification.status === "failed" ? null : notification);
    else if (notification.status === "failed") await conn!.run("DELETE FROM policy_notifications WHERE id=$1", [id]);
    else await conn!.run("UPDATE policy_notifications SET result=$2 WHERE id=$1", [id, JSON.stringify(notification)]);
  }
  return { patients, changes: changeIds.length, configured, receiptId: id, duplicate: Boolean(previous), notification };
}

export async function policyDeliveryStatus(id: string, db?: Db, env: SmsEnvironment = process.env, request: typeof fetch = fetch): Promise<SmsResult> {
  const hosted = !db && hostedDemoEnabled();
  const conn = hosted ? undefined : db ?? await getDb();
  let result: SmsResult | null;
  if (hosted) result = await hostedReadReceipt(id);
  else {
    await ensureOutbox(conn!);
    const [row] = await conn!.query<{ result: string }>("SELECT result FROM policy_notifications WHERE id=$1", [id]);
    result = row ? JSON.parse(row.result) as SmsResult : null;
  }
  if (!result) throw new ApiError(404, "Notification receipt not found.");
  if (!result.messageId || !/^SM[0-9a-f]{32}$/i.test(result.messageId)) return result;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new ApiError(503, "Messaging credentials are missing.");
  let response: Response;
  try {
    response = await request(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${result.messageId}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}` },
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
  } catch { throw new ApiError(502, "Could not check delivery. No new message was sent."); }
  if (!response.ok) throw new ApiError(502, "Could not check delivery. No new message was sent.");
  const data = await response.json() as { status?: string };
  const allowed = ["accepted", "queued", "sending", "sent", "delivered", "read", "failed", "undelivered"];
  if (!data.status || !allowed.includes(data.status)) throw new ApiError(502, "Unknown delivery status.");
  result.deliveryStatus = data.status;
  if (["failed", "undelivered"].includes(data.status)) { result.status = "failed"; result.error = "Provider reports delivery failed. Check the WhatsApp Sandbox membership and messaging window."; }
  if (hosted) await hostedWriteReceipt(id, result);
  else await conn!.run("UPDATE policy_notifications SET result=$2 WHERE id=$1", [id, JSON.stringify(result)]);
  return result;
}
