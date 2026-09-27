import type { SmsResult } from "./sms";

export type SmsEnvironment = Record<string, string | undefined>;

function senderKey(env: SmsEnvironment): string {
  return env.MESSAGING_CHANNEL === "whatsapp" ? "TWILIO_WHATSAPP_FROM" : "TWILIO_FROM_NUMBER";
}

function address(value: string, whatsapp: boolean): string {
  const phone = value.trim().replace(/^whatsapp:/, "");
  return whatsapp ? `whatsapp:${phone}` : value.trim();
}

export function liveSmsConfigured(env: SmsEnvironment = process.env): boolean {
  return env.SMS_MODE === "live" && ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", senderKey(env), "DOCTOR_PHONE", "APP_URL", "SMS_SEND_TOKEN"].every((key) => Boolean(env[key]?.trim()));
}

/** One attempt only: a network timeout may occur after Twilio accepts the message. */
export async function sendSms(body: string, env: SmsEnvironment = process.env, request: typeof fetch = fetch): Promise<SmsResult> {
  if (!liveSmsConfigured(env)) return { mode: "preview", status: "preview", body };
  const base = { mode: "live" as const, body };
  const whatsapp = env.MESSAGING_CHANNEL === "whatsapp";
  if (env.MESSAGING_CHANNEL && !["sms", "whatsapp"].includes(env.MESSAGING_CHANNEL)) {
    return { ...base, status: "failed", error: "MESSAGING_CHANNEL must be sms or whatsapp." };
  }
  const from = address(env[senderKey(env)]!, whatsapp);
  const to = address(env.DOCTOR_PHONE!, whatsapp);
  const phonePattern = whatsapp ? /^whatsapp:\+[1-9]\d{7,14}$/ : /^\+[1-9]\d{7,14}$/;
  if (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID!) ||
      !phonePattern.test(from) || !phonePattern.test(to)) {
    return { ...base, status: "failed", error: "Check the messaging account and phone-number configuration." };
  }
  try {
    const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: number };
      const explanations: Record<number, string> = {
        20003: "Twilio rejected the credentials. Check the Account SID and Auth Token belong to the same account.",
        63015: "This recipient must join your WhatsApp Sandbox using its join code first.",
        63016: "Send a WhatsApp message to the Sandbox to open a new 24-hour window for custom messages.",
        63007: "Check that WhatsApp Sandbox is activated and TWILIO_WHATSAPP_FROM matches its sender.",
      };
      return { ...base, status: response.status >= 500 ? "unknown" : "failed", error: response.status >= 500
        ? "Send status is uncertain. Check Twilio before trying again."
        : explanations[error.code ?? 0] ?? "The messaging provider rejected the request. Check your messaging configuration before retrying." };
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
