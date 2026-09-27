"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { notifyPatient, selectAlternative } from "@/app/_lib/api";
import type { CheckResponse, PatientAlert } from "@/lib/contract";
import { displayDrugName, estMoney } from "@/components/format";
import { saveNotice, useMedishiftSession } from "@/components/medishift-session";
import { coverageSms, displayPatientId, initials } from "@/lib/medishift-view";

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
  const selection = alert.selectedAlternative ?? null;
  const [saving, setSaving] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const notice = session.notices[alert.id] ?? null;
  const [composerOpen, setComposerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(notice?.error ?? null);
  const alternatives = check?.alternatives ?? [];
  const message = coverageSms(alert, selection?.drugName ?? null);

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
        <p className="text-xl font-semibold text-[#1b1733]">{displayDrugName(alert.drugName)}</p>
        <p className="mt-1 text-sm text-[#3c3658]">Not covered · {alert.planName}</p>
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

      <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-[#e6e1f2]">
        <h2 className="text-xs font-semibold tracking-[0.14em] text-[#8a84a3]">NOTIFICATION</h2>
        {notice?.ok ? (
          <p className="mt-3 text-sm font-semibold text-[#145c32]">Patient notified</p>
        ) : notice ? (
          <p className="mt-3 text-sm text-[#9b3b3b]">Couldn&apos;t send. No phone number on file.</p>
        ) : (
          <p className="mt-3 text-sm text-[#5c5678]">Not sent yet.</p>
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
            <p className="mt-4 text-sm text-[#9b3b3b]">Couldn&apos;t send. No phone number on file.</p>
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
