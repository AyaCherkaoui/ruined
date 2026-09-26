import { describe, expect, it } from "vitest";
import { GrokClient, GrokError } from "./grok";
import { MissingApiKeyError } from "./http";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(handler: (req: { url: string; init?: RequestInit }) => Response | Promise<Response>, apiKey: string | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof fetch;
  return { grok: new GrokClient({ fetch: fetchFn, apiKey }), calls };
}

describe("GrokClient.translate", () => {
  it("throws MissingApiKeyError when XAI_API_KEY is not configured (no crash)", async () => {
    const { grok } = client(() => json({}), undefined);
    await expect(grok.translate("hello", "Spanish")).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("sends the text and target language, and returns the translated content", async () => {
    const { grok, calls } = client(() => json({ choices: [{ message: { content: " Hola $10 " } }] }), "test-key");
    const result = await grok.translate("Hello $10", "Spanish");
    expect(result).toBe("Hola $10"); // trimmed

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.messages[1].content).toContain("Hello $10");
    expect(body.messages[1].content).toContain("Spanish");
    expect(calls[0].url).toContain("/chat/completions");
  });

  it("raises GrokError on a non-ok response", async () => {
    const { grok } = client(() => json({ error: "bad" }, 500), "test-key");
    await expect(grok.translate("hi", "French")).rejects.toBeInstanceOf(GrokError);
  });

  it("raises GrokError when the response has no content", async () => {
    const { grok } = client(() => json({ choices: [] }), "test-key");
    await expect(grok.translate("hi", "French")).rejects.toBeInstanceOf(GrokError);
  });
});
