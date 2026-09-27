import { afterEach, expect, it, vi } from "vitest";
import { clearMedishiftSession, saveNotice, saveSelection } from "./medishift-session";

afterEach(() => { vi.unstubAllGlobals(); });

it("clears persisted browser history and notifies subscribers on repeated resets", () => {
  const values = new Map<string, string>();
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }, dispatchEvent });
  for (let pass = 0; pass < 3; pass++) {
    saveSelection("a", { rxcui: "1", drugName: "Demo", estMonthlyCost: 5, monthlySavings: 2, at: "now" });
    saveNotice("a", { ok: true, error: null, message: "demo", at: "now", deliveryStatus: "accepted", messageId: "demo" });
    expect(values.size).toBe(1);
    clearMedishiftSession();
    expect(values.size).toBe(0);
    expect(dispatchEvent.mock.lastCall?.[0].type).toBe("medishift-session");
  }
});
