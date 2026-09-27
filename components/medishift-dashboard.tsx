"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Alternative, PatientAlert } from "@/lib/contract";
import { displayDrugName, estMoney } from "@/components/format";
import { useMedishiftSession, type SessionNotice } from "@/components/medishift-session";
import {
  alertsToCsv,
  earliestDetectedLabel,
  groupByMedicine,
  matchesFilter,
  policyFilters,
  policySentence,
  policyUpdateCount,
  reviewCounts,
  statusLabel,
  initials,
  displayPatientId,
} from "@/lib/medishift-view";

export interface DashboardItem {
  alert: PatientAlert;
  alternatives: Alternative[];
  checkError: string | null;
}

export function MedishiftDashboard({ items }: { items: DashboardItem[] }) {
  const alerts = items.map((item) => item.alert);
  const byId = new Map(items.map((item) => [item.alert.id, item]));
  const [filter, setFilter] = useState("all");
  const [grouped, setGrouped] = useState(false);
  const session = useMedishiftSession();
  const filters = useMemo(() => policyFilters(alerts), [alerts]);
  const visible = useMemo(
    () => alerts.filter((alert) => matchesFilter(alert, filter)),
    [alerts, filter],
  );
  const counts = reviewCounts(visible);
  const policies = policyUpdateCount(visible);
  const detected = earliestDetectedLabel(visible);
  const sentence = policySentence(visible);
  const sessionSelections = visible.filter((alert) => session.selections[alert.id]).length;
  const groups = grouped ? groupByMedicine(visible) : [{ label: "", alerts: visible }];

  function exportList() {
    const csv = alertsToCsv(visible);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "medishift-affected-patients.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <section className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,1fr)]">
        <div className="flex flex-col justify-between rounded-[28px] bg-[#5c4dff] px-6 py-7 text-white shadow-sm sm:px-8 sm:py-8">
          <div>
            <p className="inline-flex rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold tracking-[0.14em]">
              {policies} POLICY {policies === 1 ? "UPDATE" : "UPDATES"}
              {detected ? ` · FROM ${detected}` : ""}
            </p>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
              {counts.total} {counts.total === 1 ? "patient" : "patients"} affected
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-white/90">{sentence}</p>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#patients"
              className="inline-flex h-12 items-center rounded-full bg-[#f0a202] px-5 text-sm font-semibold text-[#2a2110] shadow-sm hover:bg-[#e09600]"
            >
              Review patients
            </a>
            <button
              type="button"
              onClick={exportList}
              disabled={visible.length === 0}
              className="inline-flex h-12 items-center rounded-full bg-white/15 px-5 text-sm font-semibold text-white hover:bg-white/25 disabled:opacity-50"
            >
              Export list
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Total affected" value={counts.total} />
          <Stat label="Reviewed" value={counts.reviewed} />
          <Stat label="Pending" value={counts.pending} tone="pending" />
          <Stat
            label="Switched"
            value={counts.switched}
            tone="switched"
            note={sessionSelections > 0 ? `${sessionSelections} selected this session, not saved` : undefined}
          />
        </div>
      </section>

      <section id="patients" className="flex flex-col gap-4 scroll-mt-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-[#1b1733]">Patients to review</h2>
          <div className="flex flex-wrap items-center gap-2">
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
              All
            </FilterButton>
            {filters.map((item) => (
              <FilterButton key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
                {item.label}
              </FilterButton>
            ))}
            <button
              type="button"
              aria-pressed={grouped}
              onClick={() => setGrouped((value) => !value)}
              className={`ml-1 inline-flex h-10 items-center rounded-full px-3 text-sm font-medium ${grouped ? "bg-[#1b1733] text-white" : "text-[#6d6788] hover:text-[#1b1733]"}`}
            >
              Grouped by medicine
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-3xl bg-white px-6 py-10 text-[#3c3658] shadow-sm ring-1 ring-[#e6e1f2]">
            {alerts.length === 0
              ? "No patients are currently affected by this policy update."
              : "No patients match this filter."}
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <div key={group.label || "all"} className="flex flex-col gap-3">
                {grouped ? <h3 className="text-sm font-semibold text-[#5c5678]">{group.label}</h3> : null}
                <ul className="flex flex-col gap-3">
                  {group.alerts.map((alert) => (
                    <PatientRow
                      key={alert.id}
                      alert={alert}
                      alternatives={byId.get(alert.id)?.alternatives ?? []}
                      checkError={byId.get(alert.id)?.checkError ?? null}
                      selectionName={session.selections[alert.id]?.drugName ?? null}
                      notice={session.notices[alert.id] ?? null}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  note,
}: {
  label: string;
  value: number;
  tone?: "default" | "pending" | "switched";
  note?: string;
}) {
  const color = tone === "pending" ? "text-[#e5920a]" : tone === "switched" ? "text-[#1f9d55]" : "text-[#1b1733]";
  return (
    <div className="flex min-h-32 flex-col justify-between rounded-3xl bg-white px-5 py-4 shadow-sm ring-1 ring-[#ece8f6]">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-[#8a84a3]">{label.toUpperCase()}</p>
      <div>
        <p className={`text-4xl font-semibold tabular-nums tracking-tight ${color}`}>{value}</p>
        {note ? <p className="mt-1 text-xs leading-4 text-[#6d6788]">{note}</p> : null}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 max-w-full items-center rounded-full px-4 text-sm font-medium ${active ? "bg-[#1b1733] text-white" : "bg-white text-[#3c3658] ring-1 ring-[#e4dff2] hover:bg-[#f7f5fc]"}`}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

function PatientRow({
  alert,
  alternatives,
  checkError,
  selectionName,
  notice,
}: {
  alert: PatientAlert;
  alternatives: Alternative[];
  checkError: string | null;
  selectionName: string | null;
  notice: SessionNotice | null;
}) {
  return (
    <li className="rounded-[28px] bg-white px-4 py-4 shadow-sm ring-1 ring-[#e6e1f2] sm:px-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-center">
        <div className="flex min-w-0 items-center gap-3 xl:w-64">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#efeaff] text-sm font-semibold text-[#5c4dff]">
            {initials(alert.patientName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-[#1b1733]">{alert.patientName}</p>
            <p className="mt-1 inline-flex rounded-md bg-[#f4f2fb] px-2 py-0.5 font-mono text-xs text-[#5c5678]">
              {displayPatientId(alert.patientId)}
            </p>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-[#1b1733]">{displayDrugName(alert.drugName)}</p>
          <p className="mt-1 text-sm text-[#3c3658]">Not covered · {alert.planName}</p>
        </div>

        <div className="min-w-0 xl:w-80">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-[#8a84a3]">SUGGESTIONS</p>
          {checkError ? <p className="mt-2 text-sm text-[#9b3b3b]">{checkError}</p> : null}
          {alternatives.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {alternatives.map((alternative) => (
                <p key={alternative.rxcui} className="rounded-full bg-[#f4f2fb] px-3 py-1.5 text-sm font-medium text-[#3c3658]">
                  {displayDrugName(alternative.drugName)}
                  {alternative.estMonthlyCost != null ? ` · ${estMoney(alternative.estMonthlyCost)}/mo` : ""}
                </p>
              ))}
            </div>
          ) : checkError ? null : (
            <p className="mt-2 text-sm text-[#3c3658]">No formulary alternative returned</p>
          )}
          <p className="mt-2 text-xs font-medium text-[#6d6788]">{statusLabel(alert.status)}</p>
          {selectionName ? (
            <p className="mt-1 text-xs text-[#5c4dff]">Selected this session, not saved: {selectionName}</p>
          ) : null}
          {notice?.ok ? (
            <p className="mt-1 text-xs text-[#1f9d55]">Patient notified</p>
          ) : notice ? (
            <p className="mt-1 text-xs text-[#9b3b3b]">Notification not sent</p>
          ) : null}
        </div>

        <Link
          href={`/review/${alert.id}`}
          className="inline-flex h-12 shrink-0 items-center justify-center rounded-full bg-[#ece7ff] px-5 text-sm font-semibold text-[#4b3fd4] hover:bg-[#e0d9ff]"
        >
          Choose medicine
        </Link>
      </div>
    </li>
  );
}
