import type { ChangeType, CoverageResult, Patient, PatientAlert } from "./contract";
import { findAlternatives } from "./alternatives";
import { coverageForRxcuis, DEFAULT_DATA_VERSION, loadPlanContext, PlanNotFoundError, round2 } from "./coverage";
import { getDb, type Db } from "./db";
import { displayDrugName } from "./display";
import { getAllAlertStatuses, type AlertStatusRow } from "./alertStatus";
import { getPatient, listPatients } from "./patients";

// Real-vs-synthetic change source for the doctor-facing alert feed (task 1). CHANGE_SOURCE=cms
// (default) compares v1 (CMS Q2 2026 quarterly SPUF) against v2-cms (CMS September 2026 monthly
// PUF, scripts/load_puf_monthly.py) -- real CMS data both ends. CHANGE_SOURCE=synthetic falls
// back to v2 (scripts/make-v2.ts, task 8) for demos where the monthly file isn't loaded.
export const NEXT_DATA_VERSION_CMS = "v2-cms";
export const NEXT_DATA_VERSION_SYNTHETIC = "v2";

export interface ChangeSource {
  key: "cms" | "synthetic";
  toVersion: string;
  dataSource: "cms" | "synthetic";
  effectiveDate: string;
}

// Neither version carries a real per-change effective date (the formulary file has no such
// field): v2-cms's date is the CMS monthly distribution's period start (the closest real date
// attached to that snapshot); v2's is an invented placeholder (unchanged from task 9). Logged in
// PROGRESS.md.
const CMS_EFFECTIVE_DATE = "2026-09-01";
const SYNTHETIC_EFFECTIVE_DATE = "2027-01-01";

export function resolveChangeSource(): ChangeSource {
  const key = process.env.CHANGE_SOURCE === "synthetic" ? "synthetic" : "cms";
  return key === "cms"
    ? { key, toVersion: NEXT_DATA_VERSION_CMS, dataSource: "cms", effectiveDate: CMS_EFFECTIVE_DATE }
    : { key, toVersion: NEXT_DATA_VERSION_SYNTHETIC, dataSource: "synthetic", effectiveDate: SYNTHETIC_EFFECTIVE_DATE };
}

const CHANGE_TYPES: readonly ChangeType[] = ["tier_increase", "removed", "new_prior_auth", "new_step_therapy", "new_quantity_limit"];

export function alertId(patientId: string, rxcui: string, changeType: ChangeType): string {
  return `${patientId}:${rxcui}:${changeType}`;
}

/** Inverse of alertId. Null if `id` doesn't parse (unknown route param, stale id, ...). */
export function parseAlertId(id: string): { patientId: string; rxcui: string; changeType: ChangeType } | null {
  const first = id.indexOf(":");
  const last = id.lastIndexOf(":");
  if (first < 0 || first === last) return null;
  const patientId = id.slice(0, first);
  const rxcui = id.slice(first + 1, last);
  const changeType = id.slice(last + 1);
  if (!patientId || !rxcui || !CHANGE_TYPES.includes(changeType as ChangeType)) return null;
  return { patientId, rxcui, changeType: changeType as ChangeType };
}

export interface PatientChange {
  patient: Patient;
  rxcui: string;
  before: CoverageResult;
  after: CoverageResult;
  /** Every adverse change this one patient/drug pair has (can be more than one at once). */
  changeTypes: ChangeType[];
}

/**
 * Which of the 5 contract ChangeTypes apply, comparing coverage of a drug the patient was
 * ALREADY taking. A drug the plan never covered isn't a "change that hurts an existing patient",
 * so `before.status === "not_covered"` never produces a change. Multiple types can apply at once
 * (e.g. a tier increase AND a new prior-auth requirement on the same drug) -- each becomes its
 * own alert (see toAlerts), since PatientAlert.changeType is a single value.
 *
 * A cost increase at an UNCHANGED tier (e.g. the plan raised a copay/coinsurance rate without
 * moving the drug's tier) has no corresponding ChangeType in the contract and is not alerted on
 * here -- see PROGRESS.md known issues.
 */
function detectChangeTypes(before: CoverageResult, after: CoverageResult): ChangeType[] {
  if (before.status === "not_covered") return [];
  if (after.status === "not_covered") return ["removed"];
  const types: ChangeType[] = [];
  if (before.tier !== null && after.tier !== null && after.tier > before.tier) types.push("tier_increase");
  if (!before.priorAuth && after.priorAuth) types.push("new_prior_auth");
  if (!before.stepTherapy && after.stepTherapy) types.push("new_step_therapy");
  if (!before.quantityLimit && after.quantityLimit) types.push("new_quantity_limit");
  return types;
}

/** One patient's meds, compared between two data versions. [] if their plan doesn't exist in `to`
 * (logged, not thrown -- a plan can be discontinued between snapshots; that's not one of the 5
 * ChangeTypes either, so it can't be represented as an alert, but it shouldn't crash the feed). */
export async function changesForPatient(db: Db, patient: Patient, from: string, to: string): Promise<PatientChange[]> {
  let afterCtx;
  try {
    afterCtx = await loadPlanContext(db, patient.plan, to);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      console.warn(`patientAlerts: ${patient.id} (${patient.name}): plan missing from '${to}', skipping (${err.message})`);
      return [];
    }
    throw err;
  }
  const beforeCtx = await loadPlanContext(db, patient.plan, from);
  const rxcuis = patient.meds.map((m) => m.rxcui);
  const before = await coverageForRxcuis(db, beforeCtx, rxcuis);
  const after = await coverageForRxcuis(db, afterCtx, rxcuis);

  const out: PatientChange[] = [];
  for (const rxcui of rxcuis) {
    const changeTypes = detectChangeTypes(before.get(rxcui)!, after.get(rxcui)!);
    if (changeTypes.length > 0) out.push({ patient, rxcui, before: before.get(rxcui)!, after: after.get(rxcui)!, changeTypes });
  }
  return out;
}

export async function findPatientChanges(db: Db, from = DEFAULT_DATA_VERSION, to: string): Promise<PatientChange[]> {
  const out: PatientChange[] = [];
  for (const patient of await listPatients(db)) out.push(...(await changesForPatient(db, patient, from, to)));
  return out;
}

async function toAlerts(db: Db, change: PatientChange, source: ChangeSource, statuses: Map<string, AlertStatusRow>): Promise<PatientAlert[]> {
  const { patient, rxcui, before, after, changeTypes } = change;
  const [bestAlternative] = await findAlternatives(patient.plan, rxcui, { db, dataVersion: source.toVersion, limit: 1 });
  const monthlyIncrease =
    before.estMonthlyCost !== null && after.estMonthlyCost !== null ? round2(after.estMonthlyCost - before.estMonthlyCost) : null;
  const percentIncrease =
    before.estMonthlyCost !== null && after.estMonthlyCost !== null && before.estMonthlyCost > 0
      ? round2(((after.estMonthlyCost - before.estMonthlyCost) / before.estMonthlyCost) * 100)
      : null;

  return changeTypes.map((changeType) => {
    const id = alertId(patient.id, rxcui, changeType);
    const status = statuses.get(id) ?? { status: "new" as const, switchedTo: null };
    return {
      id,
      patientId: patient.id,
      patientName: patient.name,
      age: patient.age,
      language: patient.language,
      planName: patient.plan.planName,
      rxcui,
      drugName: after.drugName,
      displayName: displayDrugName(after.drugName),
      changeType,
      oldTier: before.tier,
      newTier: after.tier,
      oldMonthlyCost: before.estMonthlyCost,
      newMonthlyCost: after.estMonthlyCost,
      monthlyIncrease,
      percentIncrease,
      effectiveDate: source.effectiveDate,
      dataSource: source.dataSource,
      bestAlternative: bestAlternative ?? null,
      status: status.status,
      switchedTo: status.switchedTo,
    };
  });
}

/** Every current PatientAlert (any status, including dismissed), largest dollar increase first. */
export async function buildPatientAlerts(db?: Db, source: ChangeSource = resolveChangeSource()): Promise<PatientAlert[]> {
  const conn = db ?? (await getDb());
  const changes = await findPatientChanges(conn, DEFAULT_DATA_VERSION, source.toVersion);
  const statuses = await getAllAlertStatuses(conn);

  const alerts: PatientAlert[] = [];
  for (const change of changes) alerts.push(...(await toAlerts(conn, change, source, statuses)));

  const increase = (a: PatientAlert) => a.monthlyIncrease ?? 0;
  return alerts.sort((a, b) => increase(b) - increase(a) || a.patientName.localeCompare(b.patientName) || a.drugName.localeCompare(b.drugName));
}

/** One alert by id, for the switch/dismiss/message routes. Null if the id doesn't parse, the
 * patient is unknown, or the underlying data no longer shows that change. */
export async function getPatientAlert(id: string, db?: Db, source: ChangeSource = resolveChangeSource()): Promise<PatientAlert | null> {
  const parsed = parseAlertId(id);
  if (!parsed) return null;
  const conn = db ?? (await getDb());
  const patient = await getPatient(parsed.patientId, conn);
  if (!patient) return null;

  const changes = await changesForPatient(conn, patient, DEFAULT_DATA_VERSION, source.toVersion);
  const change = changes.find((c) => c.rxcui === parsed.rxcui && c.changeTypes.includes(parsed.changeType));
  if (!change) return null;

  const statuses = await getAllAlertStatuses(conn);
  const [alert] = await toAlerts(conn, { ...change, changeTypes: [parsed.changeType] }, source, statuses);
  return alert ?? null;
}
