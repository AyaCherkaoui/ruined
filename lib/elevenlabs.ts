import { MissingApiKeyError } from "./http";

// Minimal client for ElevenLabs text-to-speech, used to read the (possibly translated) patient
// message aloud. A single multilingual model handles every patient language from one voice, so
// there is no per-language voice selection.

const DEFAULT_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2"; // multilingual, per the task instructions
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs' stock "Rachel" voice; overridable with ELEVENLABS_VOICE_ID

export class ElevenLabsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

export interface ElevenLabsOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  voiceId?: string;
  model?: string;
  baseUrl?: string;
}

export class ElevenLabsClient {
  private fetchFn: typeof fetch;
  private apiKey: string | undefined;
  private voiceId: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: ElevenLabsOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
    this.voiceId = opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
    this.model = opts.model ?? process.env.ELEVENLABS_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  }

  /** Synthesize `text` to speech, returning raw mp3 bytes. */
  async synthesize(text: string): Promise<Buffer> {
    if (!this.apiKey) throw new MissingApiKeyError("ELEVENLABS_API_KEY");

    const res = await this.fetchFn(`${this.baseUrl}/text-to-speech/${this.voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.model }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ElevenLabsError(`ElevenLabs API error ${res.status}${body ? `: ${body}` : ""}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
