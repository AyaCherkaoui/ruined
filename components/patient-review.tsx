"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { notifyPatient } from "@/app/_lib/api";
import type { CheckResponse, PatientAlert } from "@/lib/contract";
import { displayDrugName, estMoney, STATUS_STYLE } from "@/components/format";
import { saveNotice, saveSelection, useMedishiftSession } from "@/components/medishift-session";
import {
  alternativeSavingsLabel,
  changeLabel,
  coverageHeadline,
  coverageSms,
  displayPatientId,
  formatTimestamp,
  impactSentence,
  initials,
} from "@/lib/medishift-view";

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
  const session = useMedishiftSession();
  const selection = session.selections[alert.id] ?? null;
  const notice = session.notices[alert.id] ?? null;
  const [composerOpen, setComposerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(notice?.error ?? null);
  const alternatives = check?.alternatives ?? [];
  const message = coverageSms(alert, selection?.drugName ?? null);
  const coverage = check?.coverage ?? null;

  function choose(rxcui: string) {
    const alternative = alternatives.find((item) => item.rxcui === rxcui);
    if (!alternative) return;
    saveSelection(alert.id, {
      rxcui: alternative.rxcui,
      drugName: displayDrugName(alternative.drugName),
      estMonthlyCost: alternative.estMonthlyCost,
      monthlySavings: alternative.monthlySavings,
      at: new Date().toISOString(),
    });
  }

  async function send() {
    setSending(true);
    setSendError(null);
    try {
      const result = await notifyPatient(alert.patientId, message);
      saveNotice(alert.id, {
        ok: true,
        error: null,
        message: result.message,
        at: result.at,
        deliveryStatus: result.deliveryStatus,
        messageId: result.messageId,
      });
      setComposerOpen(false);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : "Unable to send notification.";
      const at = new Date().toISOString();
      setSendError(error);
      saveNotice(alert.id, {
        ok: false,
        error,
        message,
        at,
        deliveryStatus: null,
        messageId: null,
      });
    } finally {
      setSending(false);
    }
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
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">CURRENT MEDICATION</h2>
        <p className="mt-3 text-xl font-semibold text-[#1b1733]">{displayDrugName(alert.drugName)}</p>
        <p className="mt-1 text-sm text-[#5c5678]">{alert.drugName}</p>
        <p className="mt-1 text-sm text-[#5c5678]">RXCUI {alert.rxcui}</p>
        <p className="mt-4 text-sm font-semibold text-[#9b3b3b]">{coverageHeadline(alert)}</p>
        <p className="mt-1 text-sm text-[#3c3658]">{alert.planName}</p>
        <p className="text-sm text-[#3c3658]">
          {alert.contractId}-{alert.planId}
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Fact label="Last covered estimate" value={`${estMoney(alert.oldMonthlyCost)}/mo`} />
          <Fact label="Current estimate" value={alert.newMonthlyCost == null ? "Not covered" : `${estMoney(alert.newMonthlyCost)}/mo`} />
        </dl>
        {coverage ? (
          <p className="mt-4 text-sm text-[#3c3658]">
            Live check on {alert.toVersion}: {STATUS_STYLE[coverage.status].label}
            {coverage.tier != null ? `, tier ${coverage.tier}` : ""}
            {coverage.priorAuth ? ", prior auth" : ""}
            {coverage.stepTherapy ? ", step therapy" : ""}
            {coverage.quantityLimit ? ", quantity limit" : ""}
            {coverage.estMonthlyCost != null ? `, ${estMoney(coverage.estMonthlyCost)}/mo` : ""}. This is an estimate.
          </p>
        ) : null}
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">FORMULARY CHANGE</h2>
        <p className="mt-3 text-lg font-semibold text-[#1b1733]">{changeLabel(alert)}</p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Fact label="Previous coverage" value={alert.oldTier == null ? "No tier on file" : `Tier ${alert.oldTier}, ${estMoney(alert.oldMonthlyCost)}/mo`} />
          <Fact label="Current coverage" value={alert.newTier == null && alert.newMonthlyCost == null ? "Not on the formulary" : `Tier ${alert.newTier ?? "—"}, ${estMoney(alert.newMonthlyCost)}/mo`} />
          <Fact label="Detected" value={formatTimestamp(alert.detectedAt)} />
          <Fact label="Formulary versions" value={`${alert.fromVersion} → ${alert.toVersion}`} />
        </dl>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">PATIENT IMPACT</h2>
        <p className="mt-3 text-sm leading-6 text-[#3c3658]">{impactSentence(alert)}</p>
        <p className="mt-3 text-sm text-[#5c5678]">Workflow status on file: {alert.status}.</p>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">SUGGESTED ALTERNATIVES</h2>
        {checkError ? (
          <div className="mt-4">
            <p className="text-sm text-[#9b3b3b]">Unable to load suggested alternatives.</p>
            <p className="mt-1 text-xs text-[#6d6788]">{checkError}</p>
            <button type="button" onClick={() => router.refresh()} className="mt-3 text-sm font-semibold text-[#5c4dff]">
              Retry
            </button>
          </div>
        ) : null}
        {!checkError && alternatives.length === 0 ? (
          <p className="mt-4 text-sm leading-6 text-[#3c3658]">
            No covered alternative was returned for this plan and drug. The stored alert also has{" "}
            {alert.bestAlternativeName ? displayDrugName(alert.bestAlternativeName) : "no suggested switch"}.
          </p>
        ) : null}
        <ul className="mt-4 flex flex-col gap-3">
          {alternatives.map((alternative) => {
            const selected = selection?.rxcui === alternative.rxcui;
            const savings = alternativeSavingsLabel(alternative);
            return (
              <li key={alternative.rxcui}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => choose(alternative.rxcui)}
                  className={`w-full rounded-2xl px-4 py-4 text-left ring-1 ${selected ? "bg-[#f3f0ff] ring-[#5c4dff]" : "bg-[#faf9fd] ring-[#e6e1f2] hover:bg-white"}`}
                >
                  <span className="block text-base font-semibold text-[#1b1733]">{displayDrugName(alternative.drugName)}</span>
                  <span className="mt-1 block text-sm text-[#5c5678]">{alternative.drugName}</span>
                  <span className="mt-2 block text-sm text-[#3c3658]">
                    {STATUS_STYLE[alternative.status].label}
                    {alternative.tier != null ? ` · tier ${alternative.tier}` : ""}
                    {alternative.estMonthlyCost != null ? ` · ${estMoney(alternative.estMonthlyCost)}/mo` : ""}
                  </span>
                  {savings ? <span className="mt-1 block text-sm text-[#1f9d55]">{savings}</span> : (
                    <span className="mt-1 block text-sm text-[#6d6788]">No savings estimate. The current drug has no covered price to compare.</span>
                  )}
                  {alternative.priorAuth || alternative.stepTherapy || alternative.quantityLimit ? (
                    <span className="mt-1 block text-xs text-[#8a5a12]">
                      {[alternative.priorAuth ? "Prior auth" : null, alternative.stepTherapy ? "Step therapy" : null, alternative.quantityLimit ? "Quantity limit" : null].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                  {selected ? <span className="mt-2 block text-xs font-semibold text-[#5c4dff]">Selected this session. Not saved.</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {selection ? (
          <p className="mt-4 text-sm text-[#3c3658]">
            Selected this session, not saved: {selection.drugName}
            {selection.estMonthlyCost != null ? ` at ${estMoney(selection.estMonthlyCost)}/mo` : ""}.
          </p>
        ) : null}
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">NOTIFICATION</h2>
        {notice?.ok ? (
          <div className="mt-4 rounded-2xl bg-[#f1fbf4] px-4 py-4 text-sm text-[#145c32]">
            <p className="font-semibold">Patient notified</p>
            <p className="mt-1">SMS sent successfully.</p>
            <p className="mt-2">Patient: {alert.patientName}</p>
            <p>Time: {formatTimestamp(notice.at)}</p>
            <p>Status: {notice.deliveryStatus ?? "Sent"}</p>
            {notice.messageId ? <p>Message id: {notice.messageId}</p> : null}
            <p className="mt-2 whitespace-pre-wrap text-[#1b1733]">{notice.message}</p>
          </div>
        ) : notice ? (
          <div className="mt-4 rounded-2xl bg-[#fff6f6] px-4 py-4 text-sm text-[#6d2430]">
            <p className="font-semibold">Unable to send notification.</p>
            <p className="mt-2">Attempted {formatTimestamp(notice.at)} for {alert.patientName}.</p>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#7a4a52]">{notice.error}</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[#5c5678]">No notification has been sent for this patient.</p>
        )}
        <button
          type="button"
          onClick={() => {
            setComposerOpen(true);
            setSendError(null);
          }}
          className="mt-4 inline-flex h-12 items-center rounded-full bg-[#5c4dff] px-5 text-sm font-semibold text-white hover:bg-[#4d3ff0]"
        >
          Notify patient
        </button>
      </section>

      {composerOpen ? (
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#d9d3ee]">
          <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">PATIENT NOTIFICATION</h2>
          <dl className="mt-4 grid gap-3">
            <Fact label="Patient" value={alert.patientName} />
            <Fact label="Phone" value="No phone number on file" />
          </dl>
          <p className="mt-2 text-xs leading-5 text-[#6d6788]">
            Patient records in this database are an id and a name only. The doctor&apos;s phone is not used here.
          </p>
          <label className="mt-4 block text-xs font-semibold tracking-[0.12em] text-[#8a84a3]" htmlFor="sms-message">
            MESSAGE
          </label>
          <textarea
            id="sms-message"
            readOnly
            value={message}
            rows={5}
            className="mt-2 w-full rounded-2xl bg-[#f7f5fc] px-4 py-3 text-sm leading-6 text-[#1b1733] ring-1 ring-[#e6e1f2]"
          />
          {sendError ? (
            <div className="mt-4 rounded-2xl bg-[#fff6f6] px-4 py-3 text-sm text-[#6d2430]">
              <p className="font-semibold">Unable to send notification.</p>
              <p className="mt-2 text-xs leading-5">{sendError}</p>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={sending}
              onClick={() => void send()}
              className="inline-flex h-12 items-center rounded-full bg-[#1b1733] px-5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {sending ? "Sending…" : sendError ? "Try again" : "Send SMS"}
            </button>
            <button type="button" onClick={() => setComposerOpen(false)} className="inline-flex h-12 items-center px-3 text-sm font-medium text-[#5c5678]">
              Close
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-[#8a84a3]">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-[#1b1733]">{value}</dd>
    </div>
  );
}
