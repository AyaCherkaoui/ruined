"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { dismissAlert } from "@/app/_lib/api";
import type { ChangeType, PatientAlert } from "@/lib/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { coverageChangeSentence, displayDrugName, estMoney } from "@/components/format";

const CHANGE_BADGE: Record<ChangeType, { label: string; className: string }> = {
  tier_increase: { label: "Tier increase", className: "border-amber-300 bg-amber-50 text-amber-950" },
  removed: { label: "Removed from plan", className: "border-red-200 bg-red-50 text-red-800" },
  new_prior_auth: { label: "New prior auth", className: "border-amber-300 bg-amber-50 text-amber-950" },
  new_step_therapy: { label: "New step therapy", className: "border-amber-300 bg-amber-50 text-amber-950" },
  new_quantity_limit: { label: "New quantity limit", className: "border-amber-300 bg-amber-50 text-amber-950" },
};

function isOpen(alert: PatientAlert): boolean {
  return alert.status === "new" || alert.status === "seen";
}

export function AlertInbox({ alerts }: { alerts: PatientAlert[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = alerts.filter(isOpen);
  const patients = new Set(open.map((alert) => alert.patientId)).size;

  async function onDismiss(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await dismissAlert(id);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not dismiss this alert");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4">
        <h1 className="max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-5xl">
          HeadsUp patient alerts
        </h1>
        <p className="text-lg text-neutral-800">
          <span className="text-4xl font-semibold tabular-nums text-red-700">{patients}</span>
          {" "}
          {patients === 1 ? "patient is" : "patients are"} affected by a coverage change
        </p>
        <p className="max-w-2xl text-sm leading-6 text-neutral-600">
          Every dollar amount is an estimate for a typical 30-day fill. Deductibles and coverage phases are not included.
        </p>
      </header>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {open.length === 0 ? (
        <Card>
          <CardContent className="text-base text-emerald-800">No open alerts.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((alert) => {
            const badge = CHANGE_BADGE[alert.changeType];
            return (
              <li key={alert.id}>
                <Card className="border-l-4 border-l-red-600">
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-neutral-950">{alert.patientName}</p>
                        <p className="mt-0.5 text-sm text-neutral-600">{alert.planName}</p>
                      </div>
                      <Badge className={`h-7 px-2.5 text-sm ${badge.className}`}>{badge.label}</Badge>
                    </div>
                    <p className="text-base text-neutral-800">{coverageChangeSentence(alert)}</p>
                    {alert.bestAlternativeName ? (
                      <p className="text-sm text-emerald-800">
                        Cheaper covered option: {displayDrugName(alert.bestAlternativeName)} at {estMoney(alert.bestAlternativeCost)}/month
                      </p>
                    ) : (
                      <p className="text-sm font-medium text-red-700">No safe cheaper option</p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-fit px-4"
                      disabled={pendingId === alert.id}
                      onClick={() => void onDismiss(alert.id)}
                    >
                      {pendingId === alert.id ? "Dismissing…" : "Dismiss"}
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
