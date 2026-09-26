import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ALERT_STATUS, getAllAlertStatuses, getAlertStatus, resetAllAlertStatuses, setAlertStatus } from "./alertStatus";
import { openDb, type Db } from "./db";

describe("alertStatus", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb({ path: ":memory:" });
  });
  afterAll(async () => {
    await db.close();
  });

  it("an alert with no row is 'new' with no switchedTo", async () => {
    expect(await getAlertStatus("no-such-alert", db)).toEqual(DEFAULT_ALERT_STATUS);
    expect(await getAllAlertStatuses(db)).toEqual(new Map());
  });

  it("setAlertStatus persists status and switchedTo, and getAllAlertStatuses reflects it", async () => {
    await setAlertStatus("a1", "switched", "999", db);
    expect(await getAlertStatus("a1", db)).toEqual({ status: "switched", switchedTo: "999" });
    expect(await getAllAlertStatuses(db)).toEqual(new Map([["a1", { status: "switched", switchedTo: "999" }]]));
  });

  it("setAlertStatus again on the same id updates it (not a duplicate row) and preserves created_at", async () => {
    const [before] = await db.query<{ created_at: string }>("SELECT created_at FROM alert_status WHERE alert_id = 'a1'");
    await setAlertStatus("a1", "dismissed", null, db);
    expect(await getAlertStatus("a1", db)).toEqual({ status: "dismissed", switchedTo: null });
    const rows = await db.query("SELECT alert_id FROM alert_status WHERE alert_id = 'a1'");
    expect(rows).toHaveLength(1);
    const [after] = await db.query<{ created_at: string }>("SELECT created_at FROM alert_status WHERE alert_id = 'a1'");
    expect(after.created_at).toEqual(before.created_at);
  });

  it("resetAllAlertStatuses clears every row back to the 'new' default", async () => {
    await setAlertStatus("a2", "patient_notified", null, db);
    expect((await getAllAlertStatuses(db)).size).toBe(2);
    await resetAllAlertStatuses(db);
    expect(await getAllAlertStatuses(db)).toEqual(new Map());
    expect(await getAlertStatus("a1", db)).toEqual(DEFAULT_ALERT_STATUS);
  });
});
