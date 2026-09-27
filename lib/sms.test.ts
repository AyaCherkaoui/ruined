import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSms } from "./sms";
import { sendSms, type SmsEnvironment } from "./twilio";
import { POST } from "../app/api/notify/route";
import { coverageAlertStore } from "./coverageAlerts";

// Deliberately synthetic transport fixtures, never used to contact a provider.
const env: SmsEnvironment = {
  SMS_MODE: "live", TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-secret", TWILIO_FROM_NUMBER: "+15005550006",
  DOCTOR_PHONE: "+15005550001", APP_URL: "https://example.test", SMS_SEND_TOKEN: "test-key",
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("generic SMS content and transport", () => {
  it("uses a generic review link without query data or alert details", () => {
    const body = buildSms("https://example.test/private?patient=secret", true);
    expect(body).toContain("demo");
    expect(body).toContain("https://example.test/coverage-alerts");
    expect(body).not.toMatch(/secret|private|Eliquis|NovoLog|patients|\d/);
    expect(body.length).toBeLessThanOrEqual(320);
    expect(() => buildSms("javascript:alert(1)")).toThrow();
    expect(() => buildSms("https://user:password@example.test")).toThrow();
  });
  it("previews without any network request when configuration is incomplete or disabled", async () => {
    const request = vi.fn();
    for (const key of Object.keys(env)) {
      expect((await sendSms("generic", { ...env, [key]: undefined }, request)).status).toBe("preview");
    }
    expect((await sendSms("generic", { ...env, SMS_MODE: "preview" }, request)).status).toBe("preview");
    expect(request).not.toHaveBeenCalled();
  });
  it("posts authenticated form data and reports acceptance without exposing recipients", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ sid: "SMtest", status: "queued" }));
    const result = await sendSms("generic", env, request);
    expect(result).toEqual({ mode: "live", status: "accepted", body: "generic" });
    const [url, init] = request.mock.calls[0];
    expect(url).toContain(`/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body.get("To")).toBe(env.DOCTOR_PHONE);
    expect(init.body.get("Body")).toBe("generic");
    expect(JSON.stringify(result)).not.toContain(env.DOCTOR_PHONE);
  });
  it("redacts provider failures and never automatically retries ambiguous results", async () => {
    const rejected = vi.fn().mockResolvedValue(Response.json({ message: "private credentials" }, { status: 400 }));
    expect(await sendSms("generic", env, rejected)).toMatchObject({ status: "failed" });
    const timeout = vi.fn().mockRejectedValue(new Error("private credentials"));
    const result = await sendSms("generic", env, timeout);
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("private credentials");
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});

describe("SMS endpoint", () => {
  const post = (body: unknown, token?: string) => POST(new Request("http://localhost/api/notify", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
  it("rejects invalid payloads and unknown alerts", async () => {
    vi.stubEnv("SMS_MODE", "preview");
    expect((await post({})).status).toBe(400);
    expect((await post({ changeId: "missing", preview: true })).status).toBe(404);
  });
  it("previews, authorizes live sends, deduplicates concurrent sends, and rejects resolved alerts", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value!);
    await coverageAlertStore().reset();
    const [alert] = await coverageAlertStore().list();
    const request = vi.fn().mockResolvedValue(Response.json({ sid: "SMtest", status: "queued" }));
    vi.stubGlobal("fetch", request);
    expect(await (await post({ changeId: alert.id, preview: true })).json()).toMatchObject({ status: "preview" });
    expect((await post({ changeId: alert.id })).status).toBe(401);
    expect((await post({ changeId: alert.id }, "wrong-key")).status).toBe(401);
    expect(request).not.toHaveBeenCalled();
    const results = await Promise.all([post({ changeId: alert.id }, "test-key"), post({ changeId: alert.id }, "test-key")]);
    for (const response of results) expect(await response.json()).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledTimes(1);
    // Demo reset reopens alerts but must not erase live-send deduplication.
    await coverageAlertStore().reset();
    await post({ changeId: alert.id }, "test-key");
    expect(request).toHaveBeenCalledTimes(1);
    await coverageAlertStore().resolve(alert.id);
    expect((await post({ changeId: alert.id, preview: true })).status).toBe(409);
    await coverageAlertStore().reset();
  });
});
