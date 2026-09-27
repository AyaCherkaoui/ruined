"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { selectAlternative } from "@/app/_lib/api";
import type { CheckResponse, PatientAlert } from "@/lib/contract";
import { displayDrugName, estMoney } from "@/components/format";
import { PolicyDemo } from "@/components/policy-demo";
import { policyChangeLabel, medicineLabel, displayPatientId, initials } from "@/lib/medishift-view";

export function PatientReview({
  alert,
  check,
  checkError,
}: {
  alert: PatientAlert;
  check: CheckResponse | null;
  checkError: string | null;
}) {
  const router = useRouter();
  const selection = alert.selectedAlternative ?? null;
  const [saving, setSaving] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const alternatives = check?.alternatives ?? [];

  async function choose(rxcui: string) {
    if (saving) return;
    setSaving(rxcui);
    setSelectionError(null);
    try {
      await selectAlternative(alert.id, rxcui);
      router.refresh();
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Could not save the selection. Try again.");
    } finally { setSaving(null); }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <Link href="/" className="text-sm font-medium text-[#5c4dff] hover:underline">
        Back to dashboard
      </Link>

      <header className="flex items-center gap-4">
        <span className="flex size-14 items-center justify-center rounded-full bg-[#efeaff] text-base font-semibold text-[#5c4dff]">
          {initials(alert.patientName)}
        </span>
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">PATIENT</p>
          <h1 className="text-3xl font-semibold tracking-tight text-[#1b1733]">{alert.patientName}</h1>
          <p className="mt-1 font-mono text-sm text-[#5c5678]">{displayPatientId(alert.patientId)}</p>
        </div>
      </header>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <p className="text-xl font-semibold text-[#1b1733]">{medicineLabel(alert)}</p>
        <p className="mt-1 text-sm text-[#3c3658]">{policyChangeLabel(alert.changeType)} · {alert.planName}</p>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">SUGGESTIONS</h2>
        <p className="mt-2 text-sm text-[#5c5678]">Covered on this plan. You choose.</p>
        <p className="mt-2 text-sm text-[#5c5678]">Choosing saves your review decision. No prescription is sent.</p>
        {selection ? <p role="status" className="mt-3 text-sm font-semibold text-[#145c32]">Saved selection: {displayDrugName(selection.drugName)}</p> : null}
        {selectionError ? <p role="alert" className="mt-3 text-sm text-[#9b3b3b]">{selectionError}</p> : null}
        {checkError ? (
          <div className="mt-4">
            <p className="text-sm text-[#9b3b3b]">Couldn&apos;t load suggestions.</p>
            <button type="button" onClick={() => router.refresh()} className="mt-3 text-sm font-semibold text-[#5c4dff]">
              Retry
            </button>
          </div>
        ) : null}
        {!checkError && alternatives.length === 0 ? (
          <p className="mt-4 text-sm text-[#3c3658]">No covered suggestion for this plan.</p>
        ) : null}
        <ul className="mt-4 flex flex-col gap-3">
          {alternatives.map((alternative) => {
            const selected = selection?.rxcui === alternative.rxcui;
            return (
              <li key={alternative.rxcui}>
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={saving !== null}
                  aria-busy={saving === alternative.rxcui}
                  onClick={() => void choose(alternative.rxcui)}
                  className={`flex w-full items-center justify-between gap-4 rounded-2xl px-4 py-4 text-left ring-1 ${selected ? "bg-[#f3f0ff] ring-[#5c4dff]" : "bg-[#faf9fd] ring-[#e6e1f2] hover:bg-white"}`}
                >
                  <span className="text-base font-semibold text-[#1b1733]">{displayDrugName(alternative.drugName)}</span>
                  <span className="shrink-0 text-sm text-[#3c3658]">
                    {alternative.estMonthlyCost != null ? `${estMoney(alternative.estMonthlyCost)}/mo` : ""}
                    {saving === alternative.rxcui ? " · Saving…" : selected ? " · Saved" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <PolicyDemo />
    </main>
  );
}
