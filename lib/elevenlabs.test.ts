import { describe, expect, it } from "vitest";
import { ElevenLabsClient, ElevenLabsError } from "./elevenlabs";
import { MissingApiKeyError } from "./http";

function client(handler: (req: { url: string; init?: RequestInit }) => Response | Promise<Response>, apiKey: string | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof fetch;
  return { el: new ElevenLabsClient({ fetch: fetchFn, apiKey }), calls };
}

describe("ElevenLabsClient.synthesize", () => {
  it("throws MissingApiKeyError when ELEVENLABS_API_KEY is not configured (no crash)", async () => {
    const { el } = client(() => new Response(new Uint8Array()), undefined);
    await expect(el.synthesize("hello")).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("posts to the voice's text-to-speech endpoint with the multilingual model, and returns the audio bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { el, calls } = client(() => new Response(bytes, { status: 200 }), "test-key");
    const audio = await el.synthesize("hola");
    expect(Buffer.compare(audio, Buffer.from(bytes))).toBe(0);

    expect(calls[0].url).toContain("/text-to-speech/");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toMatchObject({ text: "hola", model_id: "eleven_multilingual_v2" });
    expect((calls[0].init!.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
  });

  it("raises ElevenLabsError on a non-ok response", async () => {
    const { el } = client(() => new Response("bad voice id", { status: 400 }), "test-key");
    await expect(el.synthesize("hola")).rejects.toBeInstanceOf(ElevenLabsError);
  });
});
