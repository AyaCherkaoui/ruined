"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Play, X } from "lucide-react";
import {
  createPatientMessage,
  dismissAlert,
  emailDigest,
  getDigest,
  switchAlert,
} from "@/app/_lib/api";
import type { AlertStatus, ChangeType, Digest, PatientAlert, PatientMessage } from "@/app/_lib/alert-types";
import { DEMO_RESET_EVENT } from "@/components/site-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { displayDrugName, estMoney } from "@/components/format";

const CHANGE_BADGE: Record<ChangeType, { label: string; className: string }> = {
  tier_increase: { label: "Tier increase", className: "border-amber-300 bg-amber-50 text-amber-950" },
  removed: { label: "Removed from plan", className: "border-red-200 bg-red-50 text-red-800" },
  new_prior_auth: { label: "New prior auth", className: "border-amber-300 bg-amber-50 text-amber-950" },
  new_step_therapy: { label: "New step therapy", className: "border-amber-300 bg-amber-50 text-amber-950" },
  new_quantity_limit: { label: "New quantity limit", className: "border-amber-300 bg-amber-50 text-amber-950" },
};

const NO_ALTERNATIVE = "No safe cheaper option. Consider prior auth support or a manufacturer assistance program.";

type MessageView = PatientMessage & { translationFailed?: boolean };

function formatDate(iso: string, month: "long" | "short"): string {
  const [year, monthIndex, day] = iso.split("-").map(Number);
  if (!year || !monthIndex || !day) return iso;
  return new Date(Date.UTC(year, monthIndex - 1, day)).toLocaleDateString("en-US", {
    month,
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function percentLabel(percent: number): string {
  const rounded = Math.round(percent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function byIncrease(a: PatientAlert, b: PatientAlert): number {
  if (a.monthlyIncrease == null && b.monthlyIncrease == null) return a.patientName.localeCompare(b.patientName);
  if (a.monthlyIncrease == null) return 1;
  if (b.monthlyIncrease == null) return -1;
  return b.monthlyIncrease - a.monthlyIncrease || a.patientName.localeCompare(b.patientName);
}

function changeSentence(alert: PatientAlert): string {
  const when = formatDate(alert.effectiveDate, "long");
  const drug = alert.displayName;
  const name = alert.patientName;
  switch (alert.changeType) {
    case "tier_increase":
      return `${name}'s ${drug} moves from tier ${alert.oldTier} to tier ${alert.newTier} on ${when}, from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)} a month.`;
    case "removed":
      return `${name}'s ${drug} will be removed from ${alert.planName} on ${when}, and the estimated cost goes from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)} a month.`;
    case "new_prior_auth":
      return `${name}'s ${drug} will require prior authorization starting ${when}.`;
    case "new_step_therapy":
      return `${name}'s ${drug} will require step therapy starting ${when}.`;
    case "new_quantity_limit":
      return `${name}'s ${drug} will have a new quantity limit starting ${when}.`;
  }
}

function englishNotice(alert: PatientAlert): string {
  const first = alert.patientName.split(/\s+/)[0] ?? alert.patientName;
  const when = formatDate(alert.effectiveDate, "long");
  const alternative = alert.bestAlternative;
  const switchLine = alternative
    ? `Switching to ${displayDrugName(alternative.drugName)} is estimated at ${estMoney(alternative.estMonthlyCost)} a month.`
    : "We do not have a cheaper covered alternative.";
  return `${first}, coverage for ${alert.displayName} changes on ${when}. Estimated cost goes from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)} a month. ${switchLine}`;
}

function isResolved(status: AlertStatus): boolean {
  return status === "switched" || status === "patient_notified";
}

function playAudio(url: string) {
  void new Audio(url).play();
}

export function AlertInbox() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [messages, setMessages] = useState<Record<string, MessageView>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [emailState, setEmailState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const selectedMessage = selectedId ? messages[selectedId] : undefined;

  useEffect(() => {
    let cancel = false;
    function load() {
      getDigest()
        .then((next) => {
          if (!cancel) setDigest(next);
        })
        .catch((loadError: unknown) => {
          if (!cancel) setError(loadError instanceof Error ? loadError.message : "Could not load alerts");
        });
    }
    function onReset() {
      if (cancel) return;
      setMessages({});
      setSelectedId(null);
      setOpened(new Set());
      setEmailState("idle");
      setActionError(null);
      setError(null);
      load();
    }
    load();
    window.addEventListener(DEMO_RESET_EVENT, onReset);
    return () => {
      cancel = true;
      window.removeEventListener(DEMO_RESET_EVENT, onReset);
    };
  }, []);

  const selected = digest?.alerts.find((row) => row.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  useEffect(() => {
    if (!selected || selected.status !== "patient_notified" || selectedMessage) return;
    let cancel = false;
    const alertId = selected.id;
    createPatientMessage(alertId)
      .then((message) => {
        if (!cancel) setMessages((current) => ({ ...current, [alertId]: message }));
      })
      .catch(() => {
        if (cancel) return;
        const english = englishNotice(selected);
        setMessages((current) => ({
          ...current,
          [alertId]: {
            alertId,
            language: "English",
            text: english,
            englishText: english,
            audioUrl: null,
            translationFailed: true,
          },
        }));
      });
    return () => {
      cancel = true;
    };
  }, [selected, selectedMessage]);

  const visible = useMemo(() => {
    if (!digest) return [];
    return digest.alerts.filter((row) => row.status !== "dismissed").sort(byIncrease);
  }, [digest]);

  async function reload() {
    const next = await getDigest();
    setDigest(next);
  }

  function openAlert(id: string) {
    setSelectedId(id);
    setActionError(null);
    setOpened((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  async function onApprove(alert: PatientAlert) {
    if (!alert.bestAlternative) return;
    setPendingId(alert.id);
    setActionError(null);
    try {
      await switchAlert(alert.id, alert.bestAlternative.rxcui);
      let messageView: MessageView;
      try {
        messageView = await createPatientMessage(alert.id);
      } catch {
        const english = englishNotice(alert);
        messageView = {
          alertId: alert.id,
          language: "English",
          text: english,
          englishText: english,
          audioUrl: null,
          translationFailed: true,
        };
      }
      const next = await getDigest();
      setMessages((current) => ({ ...current, [alert.id]: messageView }));
      setDigest(next);
    } catch (approveError: unknown) {
      setActionError(approveError instanceof Error ? approveError.message : "Could not approve this switch");
    } finally {
      setPendingId(null);
    }
  }

  async function onDismiss(alert: PatientAlert) {
    setPendingId(alert.id);
    setActionError(null);
    try {
      await dismissAlert(alert.id);
      if (selectedId === alert.id) setSelectedId(null);
      await reload();
    } catch (dismissError: unknown) {
      setActionError(dismissError instanceof Error ? dismissError.message : "Could not dismiss this alert");
    } finally {
      setPendingId(null);
    }
  }

  async function onEmail() {
    setEmailState("sending");
    try {
      await emailDigest();
      setEmailState("sent");
    } catch {
      setEmailState("error");
    }
  }

  const atRisk = digest?.totalAtRisk ?? null;
  const counterTone = atRisk === 0 ? "text-emerald-800" : "text-red-700";
  const counterRule = atRisk === null ? "border-l-neutral-300" : atRisk === 0 ? "border-l-emerald-600" : "border-l-red-600";
  const riskLabel =
    atRisk === 0 ? "patients financially ruined." : atRisk === 1 ? "patient at risk" : "patients at risk";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <h1 className="max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-5xl">
          How many patients have I financially ruined?
        </h1>
        <Card className={`w-full shrink-0 border-l-4 lg:w-96 ${counterRule}`}>
          <CardContent className="flex flex-col gap-3">
            <div aria-live="polite" aria-atomic="true">
              <p className={`text-7xl font-semibold tabular-nums tracking-tight ${atRisk === null ? "text-neutral-300" : counterTone}`}>
                {atRisk === null ? "–" : atRisk}
              </p>
              <p className="text-lg text-neutral-800">{riskLabel}</p>
              {digest ? (
                <p className="mt-2 text-base text-neutral-800 tabular-nums">
                  {estMoney(digest.totalMonthlyIncrease)}/month more if nothing changes
                </p>
              ) : (
                <p className="mt-2 text-base text-neutral-500">Loading the digest…</p>
              )}
            </div>
            <Button type="button" className="h-11 w-fit px-4 text-base" disabled={emailState === "sending" || !digest} onClick={() => void onEmail()}>
              {emailState === "sending" ? "Sending…" : "Email me this digest"}
            </Button>
            {emailState === "sent" ? <p className="text-sm font-medium text-emerald-800">Digest sent.</p> : null}
            {emailState === "error" ? <p className="text-sm text-red-700">Could not send the digest.</p> : null}
          </CardContent>
        </Card>
      </header>
      <p className="max-w-2xl text-sm leading-6 text-neutral-600">
        Every dollar amount is an estimate for a typical 30-day fill. Deductibles and coverage phases are not included.
      </p>

      {error ? (
        <Alert className="border-red-200 bg-red-50 text-red-900">
          <AlertTitle>Alerts could not be loaded</AlertTitle>
          <AlertDescription className="text-red-900/80">{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <section aria-labelledby="inbox-heading" className={selected ? "hidden lg:block" : undefined}>
          <h2 id="inbox-heading" className="sr-only">
            Patients affected by upcoming plan changes
          </h2>
          {digest === null && !error ? (
            <Card>
              <CardContent className="text-base text-neutral-600">Loading alerts…</CardContent>
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <CardContent className="text-base text-emerald-800">No open alerts.</CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((row) => (
                <li key={row.id}>
                  <AlertCard
                    alert={row}
                    selected={row.id === selectedId}
                    isNew={row.status === "new" && !opened.has(row.id)}
                    onOpen={() => openAlert(row.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected ? (
          <AlertDetail
            alert={selected}
            message={messages[selected.id] ?? null}
            pending={pendingId === selected.id}
            actionError={actionError}
            onApprove={() => void onApprove(selected)}
            onDismiss={() => void onDismiss(selected)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <aside className="hidden lg:block">
            <Card>
              <CardContent className="text-base text-neutral-600">Select a patient to review the change.</CardContent>
            </Card>
          </aside>
        )}
      </div>
    </main>
  );
}

function AlertCard({
  alert,
  selected,
  isNew,
  onOpen,
}: {
  alert: PatientAlert;
  selected: boolean;
  isNew: boolean;
  onOpen: () => void;
}) {
  const resolved = isResolved(alert.status);
  const badge = CHANGE_BADGE[alert.changeType];
  const source = alert.dataSource === "cms" ? "CMS data" : "Simulated";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      aria-controls="alert-detail"
      className={`w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-teal-700 ${selected ? "ring-2 ring-teal-700" : ""}`}
    >
      <Card
        className={`border-l-4 ${resolved ? "border-l-emerald-600 bg-emerald-50" : isNew ? "border-l-amber-500 bg-amber-50" : "border-l-amber-500"}`}
      >
        <CardContent className="flex flex-col gap-2">
          <span className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-lg font-semibold text-neutral-950">{alert.patientName}</span>
              <span className="mt-0.5 block text-sm text-neutral-600">
                {alert.age} · {alert.language} · {alert.planName}
              </span>
            </span>
            {resolved ? (
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-800">
                <Check className="size-4" aria-hidden />
                {alert.status === "patient_notified" ? "Patient notified" : "Switched"}
              </span>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-neutral-950">{alert.displayName}</span>
            <Badge className={`h-7 px-2.5 text-sm ${badge.className}`}>{badge.label}</Badge>
          </span>
          <span className="text-base tabular-nums">
            <span className={resolved ? "text-neutral-500" : "text-neutral-800"}>{estMoney(alert.oldMonthlyCost)}</span>
            <span className="text-neutral-500" aria-hidden>
              {" "}
              →{" "}
            </span>
            <span className={resolved ? "text-neutral-500" : "font-semibold text-red-700"}>{estMoney(alert.newMonthlyCost)}</span>
            {alert.percentIncrease != null ? (
              <span className={`ml-2 font-semibold ${resolved ? "text-neutral-500" : "text-red-700"}`}>
                {percentLabel(alert.percentIncrease)}
              </span>
            ) : null}
          </span>
          <span className="text-sm text-neutral-500">
            Effective {formatDate(alert.effectiveDate, "short")} · {source}
          </span>
        </CardContent>
      </Card>
    </button>
  );
}

function AlertDetail({
  alert,
  message,
  pending,
  actionError,
  onApprove,
  onDismiss,
  onClose,
}: {
  alert: PatientAlert;
  message: MessageView | null;
  pending: boolean;
  actionError: string | null;
  onApprove: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const resolved = isResolved(alert.status) || message != null;
  const alternative = alert.bestAlternative;
  const badge = CHANGE_BADGE[alert.changeType];
  const showMessage = message != null || resolved;

  useEffect(() => {
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    closeRef.current?.focus();
  }, [alert.id]);

  return (
    <aside
      id="alert-detail"
      aria-labelledby="alert-detail-title"
      className="bg-white max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:overflow-auto max-lg:p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto"
    >
      <Card className="border-l-4 border-l-teal-700">
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="alert-detail-title" className="text-2xl font-semibold tracking-tight text-neutral-950">
                {alert.patientName}
              </h2>
              <p className="mt-1 text-sm text-neutral-600">
                {alert.age} · {alert.language} · {alert.planName}
              </p>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 focus-visible:ring-3 focus-visible:ring-teal-700 focus-visible:outline-none"
              aria-label="Close alert"
              onClick={onClose}
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`h-7 px-2.5 text-sm ${badge.className}`}>{badge.label}</Badge>
            <span className="text-xs text-neutral-500">{alert.dataSource === "cms" ? "CMS data" : "Simulated"}</span>
          </div>

          <p className="text-base leading-7 text-neutral-950">{changeSentence(alert)}</p>
          <p className="text-base tabular-nums text-neutral-800">
            {estMoney(alert.oldMonthlyCost)}
            <span className="text-neutral-500"> → </span>
            <span className={resolved ? "text-neutral-500" : "font-semibold text-red-700"}>{estMoney(alert.newMonthlyCost)}</span>
            {alert.percentIncrease != null ? (
              <span className={`ml-2 font-semibold ${resolved ? "text-neutral-500" : "text-red-700"}`}>
                {percentLabel(alert.percentIncrease)}
              </span>
            ) : null}
          </p>

          {alternative ? (
            <div className="rounded-lg border border-neutral-200 p-3">
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Suggested switch</p>
              <p className="mt-1 text-base font-medium text-neutral-950">{displayDrugName(alternative.drugName)}</p>
              <p className="mt-0.5 text-sm text-neutral-700 tabular-nums">
                {estMoney(alternative.estMonthlyCost)}/mo
                <span className="text-emerald-800"> · saves {estMoney(alternative.monthlySavings)}/mo</span>
              </p>
              <RestrictionNotes drug={alternative} />
            </div>
          ) : (
            <p className="text-base font-semibold text-red-700">{NO_ALTERNATIVE}</p>
          )}

          {actionError ? <p className="text-sm text-red-700">{actionError}</p> : null}

          {resolved ? null : (
            <div className="flex flex-col gap-2 sm:flex-row">
              {alternative ? (
                <Button type="button" className="h-11 flex-1 px-4 text-base" disabled={pending} onClick={onApprove}>
                  {pending ? "Saving…" : "Approve switch"}
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="h-11 flex-1 px-4 text-base" disabled={pending} onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          )}

          {showMessage ? (
            <section className="flex flex-col gap-3 border-t border-neutral-200 pt-4" aria-live="polite">
              <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Message to patient</h3>
              {message ? <MessageBody message={message} notified={alert.status === "patient_notified"} /> : (
                <p className="text-base text-neutral-600">Loading the patient message…</p>
              )}
            </section>
          ) : null}
        </CardContent>
      </Card>
    </aside>
  );
}

function MessageBody({ message, notified }: { message: MessageView; notified: boolean }) {
  if (message.translationFailed) {
    return (
      <>
        <p className="text-base leading-7 text-neutral-950">{message.englishText}</p>
        <p className="text-sm text-neutral-500">Translated message unavailable. Showing English only.</p>
      </>
    );
  }
  const showEnglish = message.text !== message.englishText;
  return (
    <>
      <p className="text-sm text-neutral-500">{message.language}</p>
      <p className="text-base leading-7 whitespace-pre-wrap text-neutral-950">{message.text}</p>
      {showEnglish ? <p className="text-sm leading-6 text-neutral-600">{message.englishText}</p> : null}
      {message.audioUrl ? (
        <PlayAudio url={message.audioUrl} />
      ) : null}
      {notified ? (
        <p className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-800">
          <Check className="size-4" aria-hidden />
          Patient notified
        </p>
      ) : null}
    </>
  );
}

function PlayAudio({ url }: { url: string }) {
  return (
    <Button type="button" variant="outline" className="h-11 w-fit px-4 text-base" onClick={() => playAudio(url)}>
      <Play aria-hidden />
      Play audio
    </Button>
  );
}

function RestrictionNotes({
  drug,
}: {
  drug: { priorAuth: boolean; stepTherapy: boolean; quantityLimit: boolean };
}) {
  const flags = [
    drug.priorAuth ? "Prior auth" : null,
    drug.stepTherapy ? "Step therapy" : null,
    drug.quantityLimit ? "Quantity limit" : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {flags.map((flag) => (
        <Badge key={flag} className="h-7 border-amber-300 bg-amber-50 px-2.5 text-sm text-amber-950">
          {flag}
        </Badge>
      ))}
    </div>
  );
}
