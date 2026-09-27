import { findAlternatives } from "./alternatives";
import type { ChangeType, CheckResponse, Doctor, DrugOption, Patient, PatientAlert, PatientAlertStatus, PatientSummary } from "./contract";
import { checkCoverage, type PlanKey } from "./coverage";
import { getDb, inTransaction, type Db } from "./db";
import { normalizeDrug } from "./drugs";
import { ApiError } from "./http";
import { CURRENT_DATA_VERSION } from "./scenario";

const STATUSES = new Set<PatientAlertStatus>(["new", "seen", "switched", "dismissed"]);
const CHANGE_TYPES = new Set<ChangeType>(["removed", "tier_increase", "new_prior_auth", "new_step_therapy", "new_quantity_limit"]);

interface AlertRow {
  id: string;
  change_id: string;
  change_type: string;
  patient_id: string;
  patient_name: string;
  prescription_id: string;
  rxcui: string;
  drug_name: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  old_monthly_cost: number | null;
  new_monthly_cost: number | null;
  best_alternative_rxcui: string | null;
  best_alternative_cost: number | null;
  best_alternative_name: string | null;
  status: string;
  created_at: unknown;
  from_version: string;
  to_version: string;
  detected_at: unknown;
  old_tier: number | null;
  new_tier: number | null;
}

const ALERT_SELECT = `
  SELECT a.id, a.change_id, c.change_type, a.patient_id, p.full_name AS patient_name,
         a.prescription_id, c.rxcui, coalesce(d.name, c.rxcui) AS drug_name,
         a.contract_id, a.plan_id, coalesce(pc.segment_id, '000') AS segment_id,
         coalesce(pl.plan_name, a.contract_id || '-' || a.plan_id) AS plan_name,
         a.old_monthly_cost, a.new_monthly_cost,
         a.best_alternative_rxcui, a.best_alternative_cost,
         CASE WHEN a.best_alternative_rxcui IS NULL THEN NULL
              ELSE coalesce(alt.name, a.best_alternative_rxcui) END AS best_alternative_name,
         a.status, a.created_at,
         c.from_version, c.to_version, c.detected_at, c.old_tier, c.new_tier
    FROM patient_alerts a
    JOIN prescriptions rx ON rx.id = a.prescription_id
    JOIN patients p ON p.id = a.patient_id
    JOIN coverage_changes c ON c.id = a.change_id
    LEFT JOIN patient_coverage pc ON pc.patient_id = a.patient_id
    LEFT JOIN drugs d ON d.rxcui = c.rxcui
    LEFT JOIN drugs alt ON alt.rxcui = a.best_alternative_rxcui
    LEFT JOIN plans pl ON pl.data_version = $1
                      AND pl.contract_id = a.contract_id
                      AND pl.plan_id = a.plan_id
                      AND pl.segment_id = pc.segment_id
`;

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return value == null ? "" : String(value);
}

function asMoney(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function asTier(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

function asStatus(value: string): PatientAlertStatus {
  return STATUSES.has(value as PatientAlertStatus) ? (value as PatientAlertStatus) : "new";
}

function asChangeType(value: string): ChangeType {
  if (!CHANGE_TYPES.has(value as ChangeType)) throw new Error(`Unknown change type ${value}`);
  return value as ChangeType;
}

function toAlert(row: AlertRow): PatientAlert {
  return {
    id: row.id,
    changeId: row.change_id,
    changeType: asChangeType(row.change_type),
    patientId: row.patient_id,
    patientName: row.patient_name,
    prescriptionId: row.prescription_id,
    rxcui: row.rxcui,
    drugName: row.drug_name,
    contractId: row.contract_id,
    planId: row.plan_id,
    segmentId: row.segment_id,
    planName: row.plan_name,
    oldMonthlyCost: asMoney(row.old_monthly_cost),
    newMonthlyCost: asMoney(row.new_monthly_cost),
    bestAlternativeRxcui: row.best_alternative_rxcui,
    bestAlternativeCost: asMoney(row.best_alternative_cost),
    bestAlternativeName: row.best_alternative_name,
    status: asStatus(row.status),
    createdAt: asIso(row.created_at),
    fromVersion: row.from_version,
    toVersion: row.to_version,
    detectedAt: asIso(row.detected_at),
    oldTier: asTier(row.old_tier),
    newTier: asTier(row.new_tier),
  };
}

async function dbOf(db?: Db): Promise<Db> {
  const conn = db ?? (await getDb());
  await assertScenarioSchema(conn);
  return conn;
}

/** The pre-merge database has patients.name/age/language. The app cannot read that shape. */
export async function assertScenarioSchema(db: Db): Promise<void> {
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patients' AND table_schema = 'main'`,
  );
  const names = new Set(cols.map((col) => col.column_name));
  if (!names.has("full_name") || names.has("age") || names.has("name")) {
    throw new ApiError(
      500,
      "This database is the pre-merge 20-patient file. The app reads data/scenario.duckdb (five patients, v1 and v2-cms).",
    );
  }
}

export async function doctorById(id: string, db?: Db): Promise<Doctor | null> {
  const conn = await dbOf(db);
  const rows = await conn.query<{ id: string; full_name: string; phone: string | null }>(
    "SELECT id, full_name, phone FROM doctors WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, fullName: row.full_name, phone: row.phone };
}

export async function patientById(id: string, db?: Db): Promise<Patient | null> {
  const conn = await dbOf(db);
  const rows = await conn.query<{ id: string; full_name: string }>(
    "SELECT id, full_name FROM patients WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, fullName: row.full_name };
}

export async function countPatients(db?: Db): Promise<number> {
  const conn = await dbOf(db);
  const rows = await conn.query<{ n: number }>("SELECT count(*) AS n FROM patients");
  return Number(rows[0]?.n ?? 0);
}

export async function alertsForDoctor(doctorId: string, db?: Db): Promise<PatientAlert[]> {
  const conn = await dbOf(db);
  const sql = `${ALERT_SELECT} WHERE rx.doctor_id = $2 ORDER BY p.full_name, a.id`;
  const rows = await conn.query<AlertRow>(sql, [CURRENT_DATA_VERSION, doctorId]);
  return withDecisions(rows.map(toAlert), conn);
}

export async function alertById(id: string, db?: Db): Promise<PatientAlert | null> {
  const conn = await dbOf(db);
  const sql = `${ALERT_SELECT} WHERE a.id = $2`;
  const rows = await conn.query<AlertRow>(sql, [CURRENT_DATA_VERSION, id]);
  return rows[0] ? (await withDecisions([toAlert(rows[0])], conn))[0] : null;
}

async function hasDecisions(db: Db): Promise<boolean> {
  return (await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='patient_alert_decisions'")).length > 0;
}

async function withDecisions(alerts: PatientAlert[], db: Db): Promise<PatientAlert[]> {
  if (!alerts.length || !await hasDecisions(db)) return alerts;
  const rows = await db.query<{ alert_id: string; rxcui: string; drug_name: string; monthly_cost: number | null; saved_at: unknown }>(
    `SELECT * FROM patient_alert_decisions WHERE alert_id IN (${alerts.map((_, i) => `$${i + 1}`).join(",")})`, alerts.map((a) => a.id));
  const decisions = new Map(rows.map((r) => [r.alert_id, { rxcui: r.rxcui, drugName: r.drug_name, estMonthlyCost: asMoney(r.monthly_cost), savedAt: asIso(r.saved_at) }]));
  return alerts.map((alert) => ({ ...alert, selectedAlternative: decisions.get(alert.id) ?? null }));
}

export async function selectAlternative(id: string, rxcui: string, db?: Db): Promise<PatientAlert> {
  const database = await dbOf(db);
  return inTransaction(database, async (conn) => {
    const alert = await alertById(id, conn);
    if (!alert) throw new ApiError(404, `Alert ${id} not found`);
    const alternatives = await findAlternatives({ contractId: alert.contractId, planId: alert.planId, segmentId: alert.segmentId }, alert.rxcui,
      { db: conn, dataVersion: CURRENT_DATA_VERSION });
    const choice = alternatives.find((a) => a.rxcui === rxcui);
    if (!choice) throw new ApiError(422, "Choose an alternative currently offered for this patient's plan.");
    // Also supports a development server whose shared handle predates this table.
    await conn.run(`CREATE TABLE IF NOT EXISTS patient_alert_decisions
      (alert_id VARCHAR PRIMARY KEY, rxcui VARCHAR NOT NULL, drug_name VARCHAR NOT NULL, monthly_cost DOUBLE PRECISION, saved_at TIMESTAMP NOT NULL)`);
    await conn.run(`INSERT INTO patient_alert_decisions VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
      ON CONFLICT (alert_id) DO UPDATE SET rxcui=excluded.rxcui, drug_name=excluded.drug_name,
      monthly_cost=excluded.monthly_cost, saved_at=CASE WHEN patient_alert_decisions.rxcui=excluded.rxcui
        THEN patient_alert_decisions.saved_at ELSE excluded.saved_at END`, [id, choice.rxcui, choice.drugName, choice.estMonthlyCost]);
    await conn.run("UPDATE patient_alerts SET status='seen' WHERE id=$1", [id]);
    return (await alertById(id, conn))!;
  });
}

export async function searchPatients(q: string, db?: Db): Promise<PatientSummary[]> {
  const conn = await dbOf(db);
  const query = q.trim();
  const rows = await conn.query<{
    id: string;
    full_name: string;
    contract_id: string;
    plan_id: string;
    segment_id: string;
    plan_name: string | null;
  }>(
    `SELECT p.id, p.full_name, pc.contract_id, pc.plan_id, pc.segment_id, pl.plan_name
       FROM patients p
       JOIN patient_coverage pc ON pc.patient_id = p.id
       LEFT JOIN plans pl ON pl.data_version = $2
                         AND pl.contract_id = pc.contract_id
                         AND pl.plan_id = pc.plan_id
                         AND pl.segment_id = pc.segment_id
      WHERE $1 = '' OR p.full_name ILIKE '%' || $1 || '%'
      ORDER BY p.full_name
      LIMIT 8`,
    [query, CURRENT_DATA_VERSION],
  );
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    plan: {
      contractId: row.contract_id,
      planId: row.plan_id,
      segmentId: row.segment_id,
      planName: row.plan_name ?? `${row.contract_id}-${row.plan_id}`,
    },
  }));
}

export async function searchPatientDrugs(patientId: string, q: string, db?: Db): Promise<DrugOption[]> {
  const conn = await dbOf(db);
  if (!patientId.trim()) throw new ApiError(400, "patientId is required");
  const patient = await conn.query<{ id: string }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (patient.length === 0) throw new ApiError(404, `Patient ${patientId} not found`);
  const query = q.trim();
  const rows = await conn.query<{ rxcui: string; drug_name: string }>(
    `SELECT pr.rxcui, coalesce(d.name, pr.rxcui) AS drug_name
       FROM prescriptions pr
       LEFT JOIN drugs d ON d.rxcui = pr.rxcui
      WHERE pr.patient_id = $1
        AND ($2 = '' OR coalesce(d.name, pr.rxcui) ILIKE '%' || $2 || '%' OR pr.rxcui = $2)
      ORDER BY drug_name`,
    [patientId, query],
  );
  return rows.map((row) => ({ rxcui: row.rxcui, drugName: row.drug_name }));
}

export interface CheckRequest {
  patientId?: string;
  contractId?: string;
  planId?: string;
  segmentId?: string;
  rxcui?: string;
  drugName?: string;
}

async function planForRequest(body: CheckRequest, db: Db): Promise<PlanKey> {
  if (body.patientId) {
    const rows = await db.query<{ contract_id: string; plan_id: string; segment_id: string }>(
      "SELECT contract_id, plan_id, segment_id FROM patient_coverage WHERE patient_id = $1",
      [body.patientId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, `Patient ${body.patientId} not found`);
    return { contractId: row.contract_id, planId: row.plan_id, segmentId: row.segment_id };
  }
  if (body.contractId && body.planId) {
    return { contractId: body.contractId, planId: body.planId, segmentId: body.segmentId || "000" };
  }
  throw new ApiError(400, "Provide patientId, or contractId and planId");
}

export async function runCheck(body: CheckRequest, db?: Db): Promise<CheckResponse> {
  const conn = await dbOf(db);
  const plan = await planForRequest(body, conn);
  let rxcui = body.rxcui?.trim() ?? "";
  if (!rxcui && body.drugName?.trim()) {
    const drug = await normalizeDrug(conn, body.drugName.trim());
    if (!drug) throw new ApiError(404, `No drug matched "${body.drugName.trim()}"`);
    if (drug.tty === "IN" || drug.tty === "BN") {
      throw new ApiError(422, "Pick a specific strength and form, not a bare ingredient or brand");
    }
    rxcui = drug.rxcui;
  }
  if (!rxcui) throw new ApiError(400, "Provide rxcui or drugName");

  const coverage = await checkCoverage(plan.contractId, plan.planId, plan.segmentId, rxcui, {
    db: conn,
    dataVersion: CURRENT_DATA_VERSION,
  });
  const alternatives = await findAlternatives(plan, rxcui, { db: conn, dataVersion: CURRENT_DATA_VERSION });
  return { coverage, alternatives };
}

export async function dismissAlert(id: string, db?: Db): Promise<PatientAlert> {
  const conn = await dbOf(db);
  const existing = await alertById(id, conn);
  if (!existing) throw new ApiError(404, `Alert ${id} not found`);
  await conn.run("UPDATE patient_alerts SET status = 'dismissed' WHERE id = $1", [id]);
  const updated = await alertById(id, conn);
  if (!updated) throw new ApiError(404, `Alert ${id} not found`);
  return updated;
}

export async function resetAlertStatuses(db?: Db): Promise<{ reset: true }> {
  const conn = await dbOf(db);
  await inTransaction(conn, async (tx) => {
    if (await hasDecisions(tx)) await tx.run("DELETE FROM patient_alert_decisions");
    await tx.run("UPDATE patient_alerts SET status = 'new'");
  });
  return { reset: true };
}
