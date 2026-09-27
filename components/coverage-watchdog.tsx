"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resolveCoverageAlert } from "@/app/_lib/api";
import type { CoverageAlert, CoverageAlertChangeType } from "@/lib/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const CHANGE_BADGE: Record<CoverageAlertChangeType, { label: string; className: string }> = {
  prior_auth_added: { label: "New prior auth", className: "border-amber-300 bg-amber-50 text-amber-950" },
  prior_auth_removed: { label: "Prior auth removed", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  step_therapy_added: { label: "New step therapy", className: "border-amber-300 bg-amber-50 text-amber-950" },
  step_therapy_removed: { label: "Step therapy removed", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  quantity_limit_added: { label: "New quantity limit", className: "border-amber-300 bg-amber-50 text-amber-950" },
  quantity_limit_removed: { label: "Quantity limit removed", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  tier_increase: { label: "Tier increase", className: "border-amber-300 bg-amber-50 text-amber-950" },
  tier_decrease: { label: "Tier decrease", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  dropped: { label: "Dropped from formulary", className: "border-red-200 bg-red-50 text-red-800" },
  restored: { label: "Restored to formulary", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
};

const HELPS_PATIENTS: ReadonlySet<CoverageAlertChangeType> = new Set([
  "prior_auth_removed",
  "step_therapy_removed",
  "quantity_limit_removed",
  "tier_decrease",
  "restored",
]);

function isOpen(alert: CoverageAlert): boolean {
  return alert.status === "open";
}

export function CoverageWatchdog({ alerts }: { alerts: CoverageAlert[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = alerts.filter(isOpen);

  async function onResolve(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await resolveCoverageAlert(id);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not resolve this alert");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4">
        <h1 className="max-w-[20ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-5xl">
          Coverage Watchdog
        </h1>
        <p className="text-lg text-neutral-800">
          <span className="text-4xl font-semibold tabular-nums text-red-700">{open.length}</span>{" "}
          open {open.length === 1 ? "plan change" : "plan changes"} affecting Eliquis (apixaban)
        </p>
        <p className="max-w-2xl text-sm leading-6 text-neutral-600">
          Change-level alerts for Eliquis 5&nbsp;mg and 2.5&nbsp;mg across watched plans. No patient
          data -- use these to find affected patients in your own records.
        </p>
      </header>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {open.length === 0 ? (
        <Card>
          <CardContent className="text-base text-emerald-800">No open coverage changes.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((alert) => {
            const badge = CHANGE_BADGE[alert.changeType];
            const goodChange = HELPS_PATIENTS.has(alert.changeType);
            return (
              <li key={alert.id}>
                <Card className={`border-l-4 ${goodChange ? "border-l-emerald-600" : "border-l-red-600"}`}>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-neutral-950">{alert.planName}</p>
                        <p className="mt-0.5 text-sm text-neutral-600">
                          {alert.insurer} &middot; {alert.planId} &middot; {alert.drug}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <Badge className={`h-7 px-2.5 text-sm ${badge.className}`}>{badge.label}</Badge>
                        {alert.isDemo ? (
                          <Badge variant="outline" className="h-5 px-2 text-[0.7rem] text-neutral-500">
                            Demo data
                          </Badge>
                        ) : null}
                      </div>
                    </div>

                    <p className="text-base text-neutral-800">{alert.summary}</p>

                    {alert.oldValue || alert.newValue ? (
                      <p className="text-sm text-neutral-700">
                        <span className="text-neutral-500">Before:</span> {alert.oldValue ?? "—"}
                        <br />
                        <span className="text-neutral-500">After:</span> {alert.newValue ?? "—"}
                      </p>
                    ) : null}

                    <p className="text-sm text-neutral-600">
                      {alert.effectiveDate ? `Effective ${alert.effectiveDate}` : "No effective date given"}
                      {alert.estimatedPatientRange
                        ? ` · Estimated ${alert.estimatedPatientRange.min}-${alert.estimatedPatientRange.max} patients (${alert.estimatedPatientRange.basis})`
                        : null}
                    </p>

                    {alert.actions.length > 0 ? (
                      <ul className="flex flex-col gap-2">
                        {alert.actions.map((action) => (
                          <li key={action.type}>
                            <details className="rounded-lg border border-neutral-200 px-3 py-2">
                              <summary className="cursor-pointer text-sm font-medium text-neutral-900">
                                {action.title}
                              </summary>
                              <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 text-sm text-neutral-700">
                                {action.steps.map((step, i) => (
                                  <li key={i}>{step}</li>
                                ))}
                              </ol>
                              {action.url ? (
                                <a
                                  href={action.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-block text-sm text-teal-800 underline underline-offset-4"
                                >
                                  Learn more
                                </a>
                              ) : null}
                            </details>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <p className="text-xs text-neutral-500">Source: {alert.source}</p>

                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-fit px-4"
                      disabled={pendingId === alert.id}
                      onClick={() => void onResolve(alert.id)}
                    >
                      {pendingId === alert.id ? "Resolving…" : "Mark resolved"}
                    </Button>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
