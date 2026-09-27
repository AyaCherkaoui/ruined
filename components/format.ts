import type { CoverageStatus } from "@/lib/contract";

/**
 * Brand in brackets when RxNorm includes one. Otherwise the ingredient and strength,
 * without a leading pack size ("3 ML", "60 ACTUAT") or the dose form.
 */
export function displayDrugName(name: string): string {
  const brand = name.match(/\[([^\]]+)\]/);
  if (brand?.[1]?.trim()) return brand[1].trim();
  const trimmed = name.trim().replace(/^\d+(?:\.\d+)?\s+(?:ML|ACTUAT|HR)\s+/i, "");
  const strength = trimmed.match(/^(.*?\d+(?:\.\d+)?\s*(?:MG|MCG|UNT|ML|%)(?:\/[A-Z]+)?)\b/i);
  if (strength?.[1]) return strength[1].trim();
  return trimmed.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}

/** Every dollar figure on screen is an estimate. */
export function estMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "est. —";
  return `est. ${amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function alertSentence(alert: {
  patientName: string;
  drugName: string;
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
}): string {
  return `${alert.patientName}'s ${displayDrugName(alert.drugName)} went from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)}/month`;
}

export function coverageChangeSentence(alert: {
  patientName: string;
  drugName: string;
  changeType: string;
  oldMonthlyCost: number | null;
  newMonthlyCost: number | null;
}): string {
  const drug = displayDrugName(alert.drugName);
  if (alert.changeType === "removed") {
    return `${alert.patientName}'s ${drug} was removed from the formulary. It was ${estMoney(alert.oldMonthlyCost)}/month.`;
  }
  return alertSentence(alert);
}

/** First name on the chart axis, unless two patients share it. */
export function chartLabel(name: string, names: readonly string[]): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  const shared = names.filter((n) => (n.trim().split(/\s+/)[0] ?? n) === first);
  return shared.length > 1 ? name : first;
}

export const STATUS_STYLE: Record<
  CoverageStatus,
  { label: string; rule: string; badge: string }
> = {
  covered: {
    label: "Covered",
    rule: "border-l-emerald-600",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  restricted: {
    label: "Restricted",
    rule: "border-l-amber-500",
    badge: "border-amber-300 bg-amber-50 text-amber-950",
  },
  not_covered: {
    label: "Not covered",
    rule: "border-l-red-600",
    badge: "border-red-200 bg-red-50 text-red-800",
  },
};
