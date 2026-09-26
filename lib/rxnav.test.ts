import { describe, expect, it } from "vitest";
import { RxNavClient, RxNavError } from "./rxnav";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(handler: (n: number) => Response | Promise<Response>, maxRetries = 1) {
  let calls = 0;
  const fetchFn = (async () => handler(++calls)) as typeof fetch;
  return { rx: new RxNavClient({ fetch: fetchFn, minIntervalMs: 0, maxRetries }), calls: () => calls };
}

describe("RxNavClient error handling", () => {
  it("does not retry a real 4xx and raises RxNavError", async () => {
    const { rx, calls } = client(() => json({}, 404));
    await expect(rx.getConcept("1")).rejects.toBeInstanceOf(RxNavError);
    expect(calls()).toBe(1);
  });

  it("retries a 503 and succeeds when it clears", async () => {
    const { rx, calls } = client((n) => (n === 1 ? json({}, 503) : json({ properties: { rxcui: "1", name: "x", tty: "SCD" } })));
    expect(await rx.getConcept("1")).toEqual({ rxcui: "1", name: "x", tty: "SCD" });
    expect(calls()).toBe(2);
  });

  it("retries a 429 (rate limit)", async () => {
    const { rx, calls } = client((n) => (n === 1 ? json({}, 429) : json({ idGroup: { rxnormId: ["7"] } })));
    expect(await rx.findRxcuiByName("x")).toEqual(["7"]);
    expect(calls()).toBe(2);
  });

  it("gives up after the retries and raises RxNavError", async () => {
    const { rx, calls } = client(() => json({}, 500));
    await expect(rx.getConcept("1")).rejects.toBeInstanceOf(RxNavError);
    expect(calls()).toBe(2); // first try + 1 retry
  });

  it("wraps a network failure in RxNavError", async () => {
    const { rx } = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(rx.getConcept("1")).rejects.toMatchObject({ name: "RxNavError", message: "fetch failed" });
  });
});
