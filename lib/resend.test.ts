import { describe, expect, it } from "vitest";
import { FROM_ADDRESS, ResendClient, ResendError } from "./resend";
import { MissingApiKeyError } from "./http";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(handler: (req: { url: string; init?: RequestInit }) => Response | Promise<Response>, apiKey: string | undefined) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof fetch;
  return { resend: new ResendClient({ fetch: fetchFn, apiKey }), calls };
}

describe("ResendClient.send", () => {
  it("throws MissingApiKeyError when RESEND_API_KEY is not configured (no crash)", async () => {
    const { resend } = client(() => json({ id: "x" }), undefined);
    await expect(resend.send({ to: "doc@example.com", subject: "s", html: "<p>h</p>" })).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("sends from the Resend sandbox sender, to the given address, and returns the id", async () => {
    const { resend, calls } = client(() => json({ id: "email_123" }), "test-key");
    const result = await resend.send({ to: "doc@example.com", subject: "Subject here", html: "<p>hi</p>" });
    expect(result).toEqual({ id: "email_123" });

    expect(calls[0].url).toContain("/emails");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toMatchObject({ from: FROM_ADDRESS, to: ["doc@example.com"], subject: "Subject here", html: "<p>hi</p>" });
  });

  it("raises ResendError on a non-ok response", async () => {
    const { resend } = client(() => json({ message: "invalid" }, 422), "test-key");
    await expect(resend.send({ to: "doc@example.com", subject: "s", html: "h" })).rejects.toBeInstanceOf(ResendError);
  });

  it("raises ResendError when the response has no id", async () => {
    const { resend } = client(() => json({}), "test-key");
    await expect(resend.send({ to: "doc@example.com", subject: "s", html: "h" })).rejects.toBeInstanceOf(ResendError);
  });
});
