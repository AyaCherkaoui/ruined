import { expect, it } from "vitest";
import { openDb, inTransaction } from "./db";

it("keeps another request outside a failing transaction on the shared connection", async () => {
  const db = await openDb({ path: ":memory:" });
  try {
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failed = inTransaction(db, async (tx) => {
      await tx.run("INSERT INTO patients VALUES ('rolled-back','First')");
      signal();
      await gate;
      throw new Error("failure");
    });
    const rejection = expect(failed).rejects.toThrow("failure");
    await started;
    const otherRequest = db.run("INSERT INTO patients VALUES ('retained','Second')");
    release();
    await rejection;
    await otherRequest;
    expect(await db.query("SELECT id FROM patients")).toEqual([{ id: "retained" }]);
  } finally { await db.close(); }
});
