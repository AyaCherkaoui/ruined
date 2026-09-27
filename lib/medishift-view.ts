import type { Alternative, PatientAlert, PatientAlertStatus } from "./contract";
import { displayDrugName, estMoney } from "../components/format";

/**
 * Dashboard counts, all from PatientAlert rows already loaded for the doctor.
 *
 * TOTAL AFFECTED = unique patients in the current filter.
 * PENDING = those patients who still have at least one alert with status "new".
 * REVIEWED = the rest: every remaining alert is seen, dismissed, or switched.
 *   Dismissed counts as reviewed because POST /api/alerts/:id/dismiss is a saved decision.
 * SWITCHED = patients with at least one alert whose stored status is "switched".
 *   The seed can write that status. A medicine picked in the browser is session-only
 *   and is not added here. Nothing in the API writes "switched" during a click.
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

/** Brand plus the strength in the RxNorm name, so 10 MG and 5 MG are not the same pill. */
export function medicineLabel(alert: PatientAlert): string {
  const brand = displayDrugName(alert.drugName);
  const dose = alert.drugName.match(/(\d+(?:\.\d+)?)\s*MG\b/i);
  if (!dose || brand.includes(dose[1])) return brand;
  return `${brand} ${dose[1]} MG`;
}

/** Brand or ingredient without strength, so every dose and plan of one medicine shares a filter. */
export function medicineName(alert: PatientAlert): string {
  return displayDrugName(alert.drugName).replace(/\s+\d[\s\S]*$/, "");
}

/** One pill per medicine actually present on the loaded alerts. */
export function policyFilters(alerts: readonly PatientAlert[]): PolicyFilter[] {
  const seen = new Map<string, PolicyFilter>();
  for (const alert of alerts) {
    const id = filterId(alert);
    if (seen.has(id)) continue;
    seen.set(id, { id, label: medicineName(alert) });
  }
  return [...seen.values()];
}

export function filterId(alert: PatientAlert): string {
  return medicineName(alert).toLowerCase();
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
  let earliest: { time: number; raw: string } | null = null;
  for (const alert of alerts) {
    const time = Date.parse(normalizeTimestamp(alert.detectedAt));
    if (!Number.isFinite(time)) continue;
    if (earliest == null || time < earliest.time) earliest = { time, raw: alert.detectedAt };
  }
  if (earliest == null) return null;
  return calendarLabel(earliest.raw);
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function formatPolicyDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatTimestamp(iso: string): string {
  const label = calendarClock(iso);
  return label ?? iso;
}

/** Calendar date as written on the timestamp, so server and browser render the same text. */
export function calendarLabel(iso: string): string | null {
  const match = normalizeTimestamp(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function calendarClock(iso: string): string | null {
  const match = normalizeTimestamp(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return calendarLabel(iso);
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  const hour = Number(match[4]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${month} ${Number(match[3])}, ${match[1]}, ${hour12}:${match[5]} ${suffix}`;
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
    return `Insurance no longer covers ${joinNames(removed)}. Pick a covered substitute for each patient.`;
  }
  if (removed.length === 0 && changed.length > 0) {
    return `Coverage changed for ${joinNames(changed)}. Review each patient and select a covered alternative.`;
  }
  return `Insurance no longer covers ${joinNames(removed)}. Coverage also changed for ${joinNames(changed)}. Review each patient and select a covered alternative.`;
}

function uniqueNames(alerts: readonly PatientAlert[]): string[] {
  const names: string[] = [];
  for (const alert of alerts) {
    const name = medicineName(alert);
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
  if (status === "new") return "Action needed";
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

export interface AttentionSummary {
  /** Patients who still have a status of "new". */
  needsDecision: number;
  /** Patients whose alerts are all seen, switched, or dismissed. */
  resolved: number;
  /** Patients where the first-ranked alternative costs less than the last covered or current estimate. */
  belowLastCovered: number;
  /** How many of those lower figures are an engine estimate of exactly 0. */
  zeroEstimates: number;
}

/** What to do first, counted from the loaded alerts and the alternatives already returned for them. */
export function attentionSummary(
  items: readonly { alert: PatientAlert; alternatives: readonly Alternative[] }[],
): AttentionSummary {
  const byPatient = new Map<string, { alert: PatientAlert; alternatives: readonly Alternative[] }[]>();
  for (const item of items) {
    const rows = byPatient.get(item.alert.patientId) ?? [];
    rows.push(item);
    byPatient.set(item.alert.patientId, rows);
  }
  let needsDecision = 0;
  let resolved = 0;
  let belowLastCovered = 0;
  let zeroEstimates = 0;
  for (const rows of byPatient.values()) {
    if (rows.some((row) => row.alert.status === "new")) needsDecision += 1;
    else resolved += 1;
    const lower = rows.find((row) => {
      const baseline = row.alert.newMonthlyCost ?? row.alert.oldMonthlyCost;
      const potential = row.alternatives[0]?.estMonthlyCost;
      return baseline != null && potential != null && potential < baseline;
    });
    if (!lower) continue;
    belowLastCovered += 1;
    if (lower.alternatives[0]?.estMonthlyCost === 0) zeroEstimates += 1;
  }
  return { needsDecision, resolved, belowLastCovered, zeroEstimates };
}

/** One sentence a doctor can read without opening the formulary tables. */
export function rowImpact(alert: PatientAlert, alternatives: readonly Alternative[]): string {
  const drug = displayDrugName(alert.drugName);
  const who = firstName(alert.patientName);
  const lead =
    alert.changeType === "removed" || alert.newMonthlyCost == null
      ? `${who}'s ${drug} is no longer covered under ${alert.planName}.`
      : `${who}'s ${drug} changed on ${alert.planName}.`;
  const last = `Last covered estimate ${estMoney(alert.oldMonthlyCost)}.`;
  if (alternatives.length === 0) return `${lead} ${last} No formulary alternative was returned.`;
  const costs = alternatives.map((item) => item.estMonthlyCost).filter((cost): cost is number => cost != null);
  const lowest = costs.length > 0 ? Math.min(...costs) : null;
  const first = alternatives[0];
  const auth = first?.priorAuth ? "Prior authorization: yes" : "Prior authorization: no";
  return `${lead} ${last} ${alternatives.length} formulary alternatives. Lowest listed estimate ${estMoney(lowest)}. First-ranked option: ${auth}.`;
}

export interface WhyStep {
  title: string;
  detail: string;
}

/** The chain from the formulary file to this patient. Every line is a field already on the alert. */
export function whySteps(alert: PatientAlert): WhyStep[] {
  const drug = displayDrugName(alert.drugName);
  const coveredNow = alert.newMonthlyCost != null;
  return [
    {
      title: "Formulary update",
      detail: `${alert.fromVersion} compared with ${alert.toVersion}. Detected ${formatTimestamp(alert.detectedAt)}.`,
    },
    {
      title: coveredNow ? `${drug} changed` : `${drug} removed`,
      detail: changeLabel(alert),
    },
    {
      title: `${alert.patientName} is taking it`,
      detail: `Prescription ${alert.prescriptionId} on ${alert.planName} (${alert.contractId}-${alert.planId}).`,
    },
    {
      title: coveredNow ? "The estimated cost changed" : "The plan no longer covers it",
      detail: coveredNow
        ? `Estimated 30-day cost went from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)}.`
        : `Last covered estimate ${estMoney(alert.oldMonthlyCost)} for 30 days. No current covered price is on file.`,
    },
  ];
}

export interface TimelineEvent {
  at: string | null;
  title: string;
  detail: string;
}

export interface TimelineSelection {
  drugName: string;
  at: string;
}

export interface TimelineNotice {
  ok: boolean;
  at: string;
  error: string | null;
  deliveryStatus: string | null;
}

/**
 * Workflow events we can actually time. Status changes have no updated-at column,
 * so reviewed / switched / dismissed are shown without a fake clock time.
 * A browser selection and an SMS attempt are included only after this session records them.
 */
export function patientTimeline(
  alert: PatientAlert,
  selection: TimelineSelection | null,
  notice: TimelineNotice | null,
): TimelineEvent[] {
  const drug = displayDrugName(alert.drugName);
  const events: TimelineEvent[] = [
    {
      at: alert.detectedAt,
      title: "Formulary change detected",
      detail: `${changeLabel(alert)} for ${drug} on ${alert.planName}.`,
    },
    {
      at: alert.createdAt,
      title: "Patient matched",
      detail: `${alert.patientName} has a prescription for ${drug} on this plan.`,
    },
  ];
  if (alert.status === "switched" && alert.bestAlternativeName) {
    events.push({
      at: null,
      title: "Alternative recorded",
      detail: `${displayDrugName(alert.bestAlternativeName)} is stored on the alert. The table has no separate time for that status.`,
    });
  } else if (alert.status === "seen") {
    events.push({
      at: null,
      title: "Marked reviewed",
      detail: "Status on file is seen. The table has no separate review time.",
    });
  } else if (alert.status === "dismissed") {
    events.push({
      at: null,
      title: "Dismissed",
      detail: "Status on file is dismissed. The table has no separate time for that decision.",
    });
  } else {
    events.push({
      at: null,
      title: "Waiting for a decision",
      detail: "Status on file is new. No alternative has been saved.",
    });
  }
  if (selection) {
    events.push({
      at: selection.at,
      title: "Alternative selected this session",
      detail: `${selection.drugName}. This choice is not saved.`,
    });
  }
  if (notice) {
    events.push({
      at: notice.at,
      title: notice.ok ? "Patient notified" : "Notification failed",
      detail: notice.ok
        ? notice.deliveryStatus ?? "The backend confirmed the send."
        : notice.error ?? "The backend did not confirm delivery.",
    });
  }
  return events;
}

/**
 * Why the first option is first. Same order as compareAlternatives in lib/alternatives.ts:
 * no prior auth, step therapy, or quantity limit first, then lower estimated cost, then lower
 * tier, then drug name. Not a clinical score.
 */
export function rankReason(alternative: Alternative, alternatives: readonly Alternative[]): string | null {
  if (alternatives[0]?.rxcui !== alternative.rxcui) return null;
  const next = alternatives[1];
  if (!next) return "Only covered formulary alternative returned for this plan.";
  const restricted = (item: Alternative) => item.priorAuth || item.stepTherapy || item.quantityLimit;
  if (restricted(next) && !restricted(alternative)) {
    return "Ranked first because it has no prior authorization, step therapy, or quantity limit, and the next option does.";
  }
  if (
    alternative.estMonthlyCost != null &&
    next.estMonthlyCost != null &&
    alternative.estMonthlyCost < next.estMonthlyCost
  ) {
    return `Ranked first because the estimated patient cost is lower than the next option (${estMoney(next.estMonthlyCost)}).`;
  }
  if (alternative.tier != null && next.tier != null && alternative.tier < next.tier) {
    return "Ranked first because the formulary tier is lower than the next option.";
  }
  return "Ranked first by drug name. Restrictions, estimated cost, and tier match the next option.";
}

export interface CostRow {
  patientName: string;
  drug: string;
  alternative: string;
  current: number;
  potential: number;
  zeroEstimate: boolean;
}

/**
 * Current figure is the live estimate, or the last covered estimate when the drug was removed.
 * Potential figure is the first-ranked formulary alternative, which is not always the cheapest
 * strength. A $0.00 result is the pricing engine's number and is not replaced.
 * Reduction is current minus potential. It can be negative. It is an estimate, not a bill.
 */
export function costComparison(
  items: readonly { alert: PatientAlert; alternatives: readonly Alternative[] }[],
): { currentTotal: number | null; potentialTotal: number | null; reduction: number | null; zeroEstimates: number; unpriced: number; rows: CostRow[] } {
  const rows: CostRow[] = [];
  let currentCents = 0;
  let potentialCents = 0;
  let unpriced = 0;
  let zeroEstimates = 0;
  for (const item of items) {
    const current = item.alert.newMonthlyCost ?? item.alert.oldMonthlyCost;
    const first = item.alternatives[0];
    const potential = first?.estMonthlyCost ?? null;
    if (current == null || potential == null || !first) {
      unpriced += 1;
      continue;
    }
    const zeroEstimate = potential === 0;
    if (zeroEstimate) zeroEstimates += 1;
    currentCents += Math.round(current * 100);
    potentialCents += Math.round(potential * 100);
    rows.push({
      patientName: item.alert.patientName,
      drug: displayDrugName(item.alert.drugName),
      alternative: displayDrugName(first.drugName),
      current,
      potential,
      zeroEstimate,
    });
  }
  if (rows.length === 0) {
    return { currentTotal: null, potentialTotal: null, reduction: null, zeroEstimates: 0, unpriced, rows };
  }
  const currentTotal = currentCents / 100;
  const potentialTotal = potentialCents / 100;
  return {
    currentTotal,
    potentialTotal,
    reduction: (currentCents - potentialCents) / 100,
    zeroEstimates,
    unpriced,
    rows,
  };
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
  if (alternative.monthlySavings > 0) return `${estMoney(alternative.monthlySavings)}/mo less than the current covered estimate`;
  return null;
}

/**
 * Why a formulary alternative is on the list. Uses only fields findAlternatives already
 * returns. Order of that list is compareAlternatives in lib/alternatives.ts: no prior auth,
 * step therapy, or quantity limit first, then lower estimated cost, then lower tier.
 * This is not a clinical equivalence judgment.
 */
export function formularyReasons(alternative: Alternative, sourceNotCovered: boolean): string[] {
  const reasons = ["Covered on this patient's plan"];
  if (alternative.estMonthlyCost != null) {
    reasons.push(`Estimated patient cost ${estMoney(alternative.estMonthlyCost)} for 30 days`);
  }
  if (alternative.tier != null) reasons.push(`Formulary tier ${alternative.tier}`);
  reasons.push(alternative.priorAuth ? "Prior authorization is required" : "No prior authorization on this product");
  if (alternative.stepTherapy) reasons.push("Step therapy is required");
  if (alternative.quantityLimit) reasons.push("A quantity limit applies");
  if (alternative.monthlySavings > 0) {
    reasons.push(`${estMoney(alternative.monthlySavings)} lower than the current covered estimate`);
  } else if (sourceNotCovered) {
    reasons.push("The current drug is not covered, so savings against a current price are not estimated");
  }
  return reasons;
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
    const label = `${medicineLabel(alert)} · ${alert.planName}`;
    const list = groups.get(label) ?? [];
    list.push(alert);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, alerts: rows }));
}
