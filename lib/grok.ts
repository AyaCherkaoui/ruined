import { MissingApiKeyError } from "./http";

// Minimal client for xAI's Grok API (OpenAI-compatible chat completions), used to translate the
// patient message into their language. NEVER used for coverage/cost numbers -- those always come
// from lib/message.ts's deterministic template; this client only translates the surrounding prose,
// and the caller (lib/message.ts) verifies every number in the translation still matches before
// trusting it.

const DEFAULT_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-fast"; // overridable with XAI_MODEL; not verified against a live key

export class GrokError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokError";
  }
}

export interface GrokOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

export class GrokClient {
  private fetchFn: typeof fetch;
  private apiKey: string | undefined;
  private model: string;
  private baseUrl: string;

  constructor(opts: GrokOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.apiKey = opts.apiKey ?? process.env.XAI_API_KEY;
    this.model = opts.model ?? process.env.XAI_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  }

  /** Translate `text` into `language`, instructed to preserve every number/date/dollar amount verbatim. */
  async translate(text: string, language: string): Promise<string> {
    if (!this.apiKey) throw new MissingApiKeyError("XAI_API_KEY");

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a medical interpreter translating a Medicare coverage notice for a patient. " +
              "Translate faithfully into the requested language, but every number, dollar amount, " +
              "percentage and date must appear EXACTLY as written in the source -- same digits, same " +
              "punctuation, never localized or reformatted. Output ONLY the translated text: no quotes, " +
              "no preamble, no explanation.",
          },
          { role: "user", content: `Translate the following into ${language}:\n\n${text}` },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GrokError(`xAI Grok API error ${res.status}${body ? `: ${body}` : ""}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const translated = data.choices?.[0]?.message?.content?.trim();
    if (!translated) throw new GrokError("xAI Grok API returned no translation");
    return translated;
  }
}
