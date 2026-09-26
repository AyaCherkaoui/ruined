import { MissingApiKeyError } from "./http";

// Minimal client for the Resend transactional email API.

const DEFAULT_BASE = "https://api.resend.com";
/** Resend's shared sandbox sender -- works with no domain verification, per the task instructions. */
export const FROM_ADDRESS = "onboarding@resend.dev";

export class ResendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendError";
  }
}

export interface ResendOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export class ResendClient {
  private fetchFn: typeof fetch;
  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(opts: ResendOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  }

  async send(input: SendEmailInput): Promise<{ id: string }> {
    if (!this.apiKey) throw new MissingApiKeyError("RESEND_API_KEY");

    const res = await this.fetchFn(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [input.to], subject: input.subject, html: input.html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ResendError(`Resend API error ${res.status}${body ? `: ${body}` : ""}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new ResendError("Resend API returned no id");
    return { id: data.id };
  }
}
