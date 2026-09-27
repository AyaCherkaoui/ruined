/** Shared, non-sensitive result shape; provider credentials never enter this object. */
export interface SmsResult {
  mode: "preview" | "live";
  status: "preview" | "accepted" | "failed" | "unknown";
  body: string;
  error?: string;
}

export function buildSms(appUrl?: string, isDemo = false): string {
  const prefix = isDemo ? "Heads Up demo: A simulated coverage alert is ready for review." : "Heads Up: A coverage alert is ready for review.";
  let link = "[app link]";
  if (appUrl) {
    const url = new URL(appUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("APP_URL must be an HTTP(S) URL without credentials.");
    }
    // Never embed alert IDs, drug names, recipients, or patient data in a URL.
    link = new URL("/coverage-alerts", url.origin).href;
  }
  const body = `${prefix} Open Heads Up to review the change and next steps: ${link}`;
  if (body.length > 320) throw new Error("The SMS review link is too long.");
  return body;
}
