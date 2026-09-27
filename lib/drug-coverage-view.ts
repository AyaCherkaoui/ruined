import { displayDrugName } from "../components/format";
import type { ChangeType, CheckResponse, CoverageChange, CoverageStatus, PatientAlert } from "./contract";

// Drug x insurance-plan view for the dashboard. Built on the server so the page receives
// drugs, plans, tiers, restrictions, costs, and an aggregate patient count -- never a patient.
// Exactly one card per (insurance plan name, drug): strengths and same-named plans are merged.

export interface Restrictions {
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: boolean;
}

/** [min, max] across the merged strengths; null when unknown. */
export type Range = [number, number] | null;

export interface PlanAlternative {
  /** Display name, e.g. "Jardiance". */
  name: string;
  strengths: string[];
  tier: number | null;
  status: CoverageStatus;
  restrictions: Restrictions;
  estMonthlyCost: number | null;
}

export interface DrugPlanRow {
  key: string;
  /** Full RxNorm names of the merged strengths. */
  drugNames: string[];
  /** e.g. ["5 MG", "10 MG"]. */
  strengths: string[];
  planName: string;
  /** Contract-plan ids, e.g. ["H0000-001"]. */
  planIds: string[];
  changeTypes: ChangeType[];
  before: Restrictions & { tiers: Range; costs: Range };
  now: Restrictions & { tiers: Range; costs: Range; status: CoverageStatus | "unknown" };
  /** Aggregate only: how many of the doctor's patients this change reaches. */
  affectedPatients: number;
  alternatives: PlanAlternative[];
}

export interface DrugGroup {
  /** Display name (brand when RxNorm has one), e.g. "Farxiga". */
  drugName: string;
  plans: DrugPlanRow[];
}

const CHANGE_ORDER: ChangeType[] = ["removed", "tier_increase", "new_prior_auth", "new_step_therapy", "new_quantity_limit"];
const MAX_ALTERNATIVES = 4;

export function strengthOf(name: string): string | null {
  return name.match(/\d+(?:\.\d+)?\s*(?:MG|MCG|UNT|ML|%)(?:\/[A-Z]+)?/i)?.[0].toUpperCase() ?? null;
}

function widen(range: Range, value: number | null | undefined): Range {
  if (value == null || !Number.isFinite(value)) return range;
  return range ? [Math.min(range[0], value), Math.max(range[1], value)] : [value, value];
}

function addUnique<T>(list: T[], value: T | null | undefined) {
  if (value != null && !list.includes(value)) list.push(value);
}

const byStrength = (a: string, b: string) => parseFloat(a) - parseFloat(b) || a.localeCompare(b);

interface Acc {
  row: DrugPlanRow;
  patients: Set<string>;
  seenChecks: Set<string>;
  statuses: Set<CoverageStatus | "unknown">;
  alternatives: Map<string, PlanAlternative>;
}

/**
 * alerts: patient-level matches (used only for grouping and counting).
 * changes: the detected formulary changes, by id.
 * checks: current coverage for each "contractId:planId:segmentId:rxcui", or null if unavailable.
 */
export function buildDrugPlanRows(
  alerts: readonly PatientAlert[],
  changes: readonly CoverageChange[],
  checks: ReadonlyMap<string, CheckResponse | null>,
): DrugGroup[] {
  const changeById = new Map(changes.map((c) => [c.id, c]));
  const rows = new Map<string, Acc>();

  for (const alert of alerts) {
    const checkKey = `${alert.contractId}:${alert.planId}:${alert.segmentId}:${alert.rxcui}`;
    const check = checks.get(checkKey) ?? null;
    const drugName = check?.coverage.drugName ?? alert.drugName;
    const brand = displayDrugName(drugName);
    const key = `${alert.planName.trim().toLowerCase()}|${brand.toLowerCase()}`;
    let acc = rows.get(key);
    if (!acc) {
      acc = {
        patients: new Set(),
        seenChecks: new Set(),
        statuses: new Set(),
        alternatives: new Map(),
        row: {
          key,
          drugNames: [],
          strengths: [],
          planName: alert.planName,
          planIds: [],
          changeTypes: [],
          before: { tiers: null, costs: null, priorAuth: false, stepTherapy: false, quantityLimit: false },
          now: { tiers: null, costs: null, status: "unknown", priorAuth: false, stepTherapy: false, quantityLimit: false },
          affectedPatients: 0,
          alternatives: [],
        },
      };
      rows.set(key, acc);
    }
    const { row } = acc;
    acc.patients.add(alert.patientId);
    addUnique(row.planIds, `${alert.contractId}-${alert.planId}`);
    addUnique(row.changeTypes, alert.changeType);
    addUnique(row.drugNames, drugName);
    addUnique(row.strengths, strengthOf(drugName));

    const change = changeById.get(alert.changeId);
    row.before.tiers = widen(row.before.tiers, change ? change.oldTier : alert.oldTier);
    row.before.costs = widen(row.before.costs, alert.oldMonthlyCost);
    if (change) {
      row.before.priorAuth ||= change.oldPriorAuth;
      row.before.stepTherapy ||= change.oldStepTherapy;
      row.before.quantityLimit ||= change.oldQuantityLimit;
    }

    if (acc.seenChecks.has(checkKey)) continue;
    acc.seenChecks.add(checkKey);
    const coverage = check?.coverage;
    acc.statuses.add(coverage?.status ?? "unknown");
    row.now.tiers = widen(row.now.tiers, coverage ? coverage.tier : change ? change.newTier : alert.newTier);
    row.now.costs = widen(row.now.costs, coverage ? coverage.estMonthlyCost : alert.newMonthlyCost);
    row.now.priorAuth ||= coverage?.priorAuth ?? change?.newPriorAuth ?? false;
    row.now.stepTherapy ||= coverage?.stepTherapy ?? change?.newStepTherapy ?? false;
    row.now.quantityLimit ||= coverage?.quantityLimit ?? change?.newQuantityLimit ?? false;
    for (const alt of check?.alternatives ?? []) {
      const name = displayDrugName(alt.drugName);
      const existing = acc.alternatives.get(name.toLowerCase());
      const cheaper = !existing || (alt.estMonthlyCost ?? Infinity) < (existing.estMonthlyCost ?? Infinity);
      const merged: PlanAlternative = cheaper
        ? {
            name,
            strengths: existing?.strengths ?? [],
            tier: alt.tier,
            status: alt.status,
            restrictions: { priorAuth: alt.priorAuth, stepTherapy: alt.stepTherapy, quantityLimit: alt.quantityLimit },
            estMonthlyCost: alt.estMonthlyCost,
          }
        : existing!;
      addUnique(merged.strengths, strengthOf(alt.drugName));
      acc.alternatives.set(name.toLowerCase(), merged);
    }
  }

  const groups = new Map<string, DrugGroup>();
  for (const acc of rows.values()) {
    const { row } = acc;
    row.affectedPatients = acc.patients.size;
    row.planIds.sort();
    row.strengths.sort(byStrength);
    row.changeTypes.sort((a, b) => CHANGE_ORDER.indexOf(a) - CHANGE_ORDER.indexOf(b));
    const statuses = [...acc.statuses];
    row.now.status = statuses.length === 1 ? statuses[0] : statuses.includes("not_covered") ? "not_covered" : statuses.includes("restricted") ? "restricted" : statuses[0];
    row.alternatives = [...acc.alternatives.values()]
      .map((a) => ({ ...a, strengths: [...a.strengths].sort(byStrength) }))
      .sort((a, b) => (a.estMonthlyCost ?? Infinity) - (b.estMonthlyCost ?? Infinity) || a.name.localeCompare(b.name))
      .slice(0, MAX_ALTERNATIVES);
    const brand = displayDrugName(row.drugNames[0]);
    const group = groups.get(brand.toLowerCase()) ?? { drugName: brand, plans: [] };
    group.plans.push(row);
    groups.set(brand.toLowerCase(), group);
  }
  for (const group of groups.values()) group.plans.sort((a, b) => a.planName.localeCompare(b.planName));
  return [...groups.values()].sort((a, b) => a.drugName.localeCompare(b.drugName));
}
