import type { SmsResult } from "./sms";

export type SmsEnvironment = Record<string, string | undefined>;

export function liveSmsConfigured(env: SmsEnvironment = process.env): boolean {
  return env.SMS_MODE === "live" && ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "DOCTOR_PHONE", "APP_URL", "SMS_SEND_TOKEN"].every((key) => Boolean(env[key]?.trim()));
}

/** One attempt only: a network timeout may occur after Twilio accepts the message. */
export async function sendSms(body: string, env: SmsEnvironment = process.env, request: typeof fetch = fetch): Promise<SmsResult> {
  if (!liveSmsConfigured(env)) return { mode: "preview", status: "preview", body };
  const base = { mode: "live" as const, body };
  if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID!) ||
      !/^\+[1-9]\d{7,14}$/.test(env.TWILIO_FROM_NUMBER!) ||
      !/^\+[1-9]\d{7,14}$/.test(env.DOCTOR_PHONE!)) {
    return { ...base, status: "failed", error: "Check the messaging account and phone-number configuration." };
  }
  try {
    const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: env.DOCTOR_PHONE!, From: env.TWILIO_FROM_NUMBER!, Body: body }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      return { ...base, status: response.status >= 500 ? "unknown" : "failed", error: response.status >= 500
        ? "Send status is uncertain. Check Twilio before trying again."
        : "The messaging provider rejected the request. Check your messaging configuration before retrying." };
    }
    const data = await response.json() as { sid?: string; status?: string };
    if (data.status === "failed" || data.status === "undelivered") {
      return { ...base, status: "failed", error: "The messaging provider could not send this text." };
    }
    if (!data.sid || !["accepted", "queued", "sending", "sent", "delivered"].includes(data.status ?? "")) {
      return { ...base, status: "unknown", error: "Send status is uncertain. Check Twilio before trying again." };
    }
    return { ...base, status: "accepted" };
  } catch {
    // Never return/log raw provider errors: they can include credentials or numbers.
    return { ...base, status: "unknown", error: "Send status is uncertain. Check Twilio before trying again." };
  }
}
