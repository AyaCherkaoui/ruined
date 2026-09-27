import type { Alternative, PatientAlert, PatientAlertStatus } from "./contract";
import { displayDrugName, estMoney } from "@/components/format";

/**
 * Dashboard counts, all from PatientAlert rows already loaded for the doctor.
 *
 * TOTAL AFFECTED = unique patients in the current filter.
 * PENDING = those patients who still have at least one alert with status "new".
 * REVIEWED = the rest: every remaining alert is seen, dismissed, or switched.
 *   Dismissed counts as reviewed because POST /api/alerts/:id/dismiss is a saved decision.
 * SWITCHED = patients with at least one alert whose stored status is "switched".
 *   Nothing in the API writes "switched" today, so this stays 0 until that exists.
 *   A medicine picked in the browser is session-only and is not added here.
 *
 * A patient with several alerts is counted once. One "new" alert keeps them pending.
 */
export interface ReviewCounts {
  total: number;
  pending: number;
  reviewed: number;
  switched: number;
}

export function reviewCounts(alerts: readonly PatientAlert[]): ReviewCounts {
  const byPatient = new Map<string, PatientAlertStatus[]>();
  for (const alert of alerts) {
    const statuses = byPatient.get(alert.patientId) ?? [];
    statuses.push(alert.status);
    byPatient.set(alert.patientId, statuses);
  }
  let pending = 0;
  let reviewed = 0;
  let switched = 0;
  for (const statuses of byPatient.values()) {
    if (statuses.includes("switched")) switched += 1;
    if (statuses.includes("new")) pending += 1;
    else reviewed += 1;
  }
  return { total: byPatient.size, pending, reviewed, switched };
}

export interface PolicyFilter {
  id: string;
  label: string;
}

/** One pill per drug + plan actually present on the loaded alerts. */
export function policyFilters(alerts: readonly PatientAlert[]): PolicyFilter[] {
  const seen = new Map<string, PolicyFilter>();
  for (const alert of alerts) {
    const id = filterId(alert);
    if (seen.has(id)) continue;
    seen.set(id, { id, label: `${displayDrugName(alert.drugName)} · ${alert.planName}` });
  }
  return [...seen.values()];
}

export function filterId(alert: PatientAlert): string {
  return `${alert.rxcui}::${alert.contractId}::${alert.planId}`;
}

export function matchesFilter(alert: PatientAlert, filterIdValue: string): boolean {
  return filterIdValue === "all" || filterId(alert) === filterIdValue;
}

/** Distinct formulary changes in the current list: drug, change type, and plan. */
export function policyUpdateCount(alerts: readonly PatientAlert[]): number {
  const keys = new Set(alerts.map((alert) => `${alert.rxcui}|${alert.changeType}|${alert.contractId}|${alert.planId}`));
  return keys.size;
}

export function earliestDetectedLabel(alerts: readonly PatientAlert[]): string | null {
  let earliest: number | null = null;
  for (const alert of alerts) {
    const time = Date.parse(normalizeTimestamp(alert.detectedAt));
    if (!Number.isFinite(time)) continue;
    if (earliest == null || time < earliest) earliest = time;
  }
  if (earliest == null) return null;
  return formatPolicyDate(new Date(earliest));
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function formatPolicyDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatTimestamp(iso: string): string {
  const time = Date.parse(normalizeTimestamp(iso));
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) return trimmed.replace(" ", "T");
  return trimmed;
}

export function policySentence(alerts: readonly PatientAlert[]): string {
  const removed = uniqueNames(alerts.filter((alert) => alert.changeType === "removed" || alert.newMonthlyCost == null));
  const changed = uniqueNames(alerts.filter((alert) => alert.changeType !== "removed" && alert.newMonthlyCost != null));
  if (alerts.length === 0) return "No formulary changes are in this view.";
  if (removed.length > 0 && changed.length === 0) {
    return `Insurance no longer covers ${joinNames(removed)}. Review each patient and select a covered alternative.`;
  }
  if (removed.length === 0 && changed.length > 0) {
    return `Coverage changed for ${joinNames(changed)}. Review each patient and select a covered alternative.`;
  }
  return `Insurance no longer covers ${joinNames(removed)}. Coverage also changed for ${joinNames(changed)}. Review each patient and select a covered alternative.`;
}

function uniqueNames(alerts: readonly PatientAlert[]): string[] {
  const names: string[] = [];
  for (const alert of alerts) {
    const name = displayDrugName(alert.drugName);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "the listed medication";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function initials(name: string): string {
  const parts = name.replace(/^Dr\.?\s+/i, "").trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function displayPatientId(id: string): string {
  return id.toUpperCase();
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function coverageHeadline(alert: PatientAlert): string {
  if (alert.changeType === "removed" || alert.newMonthlyCost == null) return "CURRENT (NOT COVERED)";
  if (alert.changeType === "tier_increase") return "CURRENT (HIGHER TIER)";
  if (alert.changeType === "new_prior_auth" || alert.changeType === "new_step_therapy" || alert.changeType === "new_quantity_limit") {
    return "CURRENT (NEW RESTRICTION)";
  }
  return "CURRENT";
}

export function costLine(alert: PatientAlert): string {
  if (alert.newMonthlyCost == null) {
    return `${alert.planName} · not covered now. Last covered estimate ${estMoney(alert.oldMonthlyCost)}/mo`;
  }
  return `${alert.planName} · ${estMoney(alert.newMonthlyCost)}/mo estimated`;
}

export function statusLabel(status: PatientAlertStatus): string {
  if (status === "new") return "Pending";
  if (status === "seen") return "Reviewed";
  if (status === "switched") return "Switched";
  return "Dismissed";
}

export function changeLabel(alert: PatientAlert): string {
  if (alert.changeType === "removed") return "Removed from the formulary";
  if (alert.changeType === "tier_increase") return "Moved to a higher tier";
  if (alert.changeType === "new_prior_auth") return "Prior authorization added";
  if (alert.changeType === "new_step_therapy") return "Step therapy added";
  return "Quantity limit added";
}

export function impactSentence(alert: PatientAlert): string {
  const drug = displayDrugName(alert.drugName);
  if (alert.changeType === "removed" || alert.newMonthlyCost == null) {
    return `${alert.patientName} is affected because ${drug} was removed from ${alert.planName} between formulary ${alert.fromVersion} and ${alert.toVersion}. The last covered 30-day estimate was ${estMoney(alert.oldMonthlyCost)}. No current covered price is on file.`;
  }
  return `${alert.patientName} is affected because ${drug} on ${alert.planName} changed (${changeLabel(alert).toLowerCase()}). The estimated 30-day cost went from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)}.`;
}

/** Coverage notice only. Does not claim a switch was saved. */
export function coverageSms(alert: PatientAlert, alternativeName: string | null): string {
  const drug = displayDrugName(alert.drugName);
  const change =
    alert.changeType === "removed" || alert.newMonthlyCost == null
      ? `your insurance coverage for ${drug} has changed, and the drug is no longer covered on your plan`
      : `your insurance coverage for ${drug} has changed (${changeLabel(alert).toLowerCase()})`;
  const review = alternativeName
    ? `Your care team is reviewing ${alternativeName} as a covered option. That choice is not saved yet.`
    : "Your care team is reviewing covered alternatives.";
  return `Hi ${firstName(alert.patientName)}, ${change}. ${review} Please contact your care team if you have questions.`;
}

export interface SavingsRow {
  patientName: string;
  drug: string;
  alternative: string;
  saved: number;
}

/**
 * Same rule as the existing dashboard: compare the current estimate (or the last
 * covered estimate when the drug was removed) with the stored alternative price.
 * Rows with no alternative, or no positive difference, are omitted. Null means
 * savings cannot be calculated.
 */
export function savingsRows(alerts: readonly PatientAlert[]): { total: number | null; rows: SavingsRow[] } {
  const rows: SavingsRow[] = [];
  let cents = 0;
  for (const alert of alerts) {
    const base = alert.newMonthlyCost ?? alert.oldMonthlyCost;
    if (base == null || alert.bestAlternativeCost == null || !alert.bestAlternativeName) continue;
    const savedCents = Math.round((base - alert.bestAlternativeCost) * 100);
    if (savedCents <= 0) continue;
    cents += savedCents;
    rows.push({
      patientName: alert.patientName,
      drug: displayDrugName(alert.drugName),
      alternative: displayDrugName(alert.bestAlternativeName),
      saved: savedCents / 100,
    });
  }
  return { total: rows.length > 0 ? cents / 100 : null, rows };
}

export function alternativeSavingsLabel(alternative: Alternative): string | null {
  if (alternative.monthlySavings > 0) return `${estMoney(alternative.monthlySavings)}/mo less than the current estimate`;
  return null;
}

export function alertsToCsv(alerts: readonly PatientAlert[]): string {
  const header = [
    "patient_id",
    "patient_name",
    "status",
    "drug",
    "rxcui",
    "plan",
    "change_type",
    "old_monthly_estimate",
    "new_monthly_estimate",
    "best_alternative",
    "best_alternative_estimate",
    "from_version",
    "to_version",
    "detected_at",
  ];
  const lines = [header.join(",")];
  for (const alert of alerts) {
    lines.push(
      [
        alert.patientId,
        alert.patientName,
        alert.status,
        alert.drugName,
        alert.rxcui,
        alert.planName,
        alert.changeType,
        alert.oldMonthlyCost ?? "",
        alert.newMonthlyCost ?? "",
        alert.bestAlternativeName ?? "",
        alert.bestAlternativeCost ?? "",
        alert.fromVersion,
        alert.toVersion,
        alert.detectedAt,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function groupByMedicine(alerts: readonly PatientAlert[]): { label: string; alerts: PatientAlert[] }[] {
  const groups = new Map<string, PatientAlert[]>();
  for (const alert of alerts) {
    const label = `${displayDrugName(alert.drugName)} · ${alert.planName}`;
    const list = groups.get(label) ?? [];
    list.push(alert);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, alerts: rows }));
}
