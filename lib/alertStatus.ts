import type { AlertStatus } from "./contract";
import { getDb, type Db } from "./db";

// Persisted workflow state for PatientAlert.status/switchedTo. The alerts themselves (which
// drugs, which patients, what changed) are always recomputed from the loaded data -- this table
// only remembers what the doctor DID about a given alert id. A missing row means "new" (the
// alert was generated but nobody has acted on it).

export interface AlertStatusRow {
  status: AlertStatus;
  switchedTo: string | null;
}

export const DEFAULT_ALERT_STATUS: AlertStatusRow = { status: "new", switchedTo: null };

interface StatusDbRow {
  alert_id: string;
  status: AlertStatus;
  switched_to: string | null;
}

/** Every stored status, keyed by alert id. Alerts with no row are "new" (not included here). */
export async function getAllAlertStatuses(db?: Db): Promise<Map<string, AlertStatusRow>> {
  const conn = db ?? (await getDb());
  const rows = await conn.query<StatusDbRow>("SELECT alert_id, status, switched_to FROM alert_status");
  return new Map(rows.map((r) => [r.alert_id, { status: r.status, switchedTo: r.switched_to }]));
}

export async function getAlertStatus(alertId: string, db?: Db): Promise<AlertStatusRow> {
  const conn = db ?? (await getDb());
  const rows = await conn.query<StatusDbRow>("SELECT alert_id, status, switched_to FROM alert_status WHERE alert_id = $1", [alertId]);
  return rows[0] ? { status: rows[0].status, switchedTo: rows[0].switched_to } : DEFAULT_ALERT_STATUS;
}

/**
 * Set an alert's status: UPDATE if a row already exists (preserves created_at), else INSERT.
 * Plain portable SQL (works on DuckDB and Postgres) -- not delete+insert like lib/drugs.ts's
 * saveDrug, because re-inserting would need to round-trip the existing created_at TIMESTAMP
 * back out as a bound parameter, which DuckDB's Node client cannot bind (only string / number /
 * boolean / null -- see lib/db.ts's SqlValue).
 */
export async function setAlertStatus(alertId: string, status: AlertStatus, switchedTo: string | null = null, db?: Db): Promise<AlertStatusRow> {
  const conn = db ?? (await getDb());
  const existing = await conn.query<{ alert_id: string }>("SELECT alert_id FROM alert_status WHERE alert_id = $1", [alertId]);
  if (existing[0]) {
    await conn.run("UPDATE alert_status SET status = $2, switched_to = $3, updated_at = CURRENT_TIMESTAMP WHERE alert_id = $1", [alertId, status, switchedTo]);
  } else {
    await conn.run(
      `INSERT INTO alert_status (alert_id, status, switched_to, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [alertId, status, switchedTo],
    );
  }
  return { status, switchedTo };
}

/** POST /api/demo/reset: back to "new" for every alert (so the demo can be replayed). */
export async function resetAllAlertStatuses(db?: Db): Promise<void> {
  const conn = db ?? (await getDb());
  await conn.run("DELETE FROM alert_status");
}
