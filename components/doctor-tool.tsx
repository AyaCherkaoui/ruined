"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, Search, X } from "lucide-react";
import {
  checkDrug,
  getUpcoming,
  searchDrugs,
  searchPatients,
  type DrugHit,
  type UpcomingRisk,
} from "@/app/_lib/api";
import type { Alternative, CheckResponse, Patient } from "@/lib/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { displayDrugName, estMoney, STATUS_STYLE } from "@/components/format";

const MAX_OPTIONS = 8;

function switchKey(patientId: string, rxcui: string) {
  return `${patientId}:${rxcui}`;
}

function percentLabel(percent: number) {
  const rounded = Math.round(percent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function restrictionBadges(drug: {
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: boolean;
}) {
  const flags = [
    drug.priorAuth ? "Prior auth" : null,
    drug.stepTherapy ? "Step therapy" : null,
    drug.quantityLimit ? "Quantity limit" : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {flags.map((flag) => (
        <Badge key={flag} className={`h-7 px-2.5 text-sm ${STATUS_STYLE.restricted.badge}`}>
          {flag}
        </Badge>
      ))}
    </div>
  );
}

function ComboBox<T>({
  label,
  step,
  placeholder,
  query,
  onQueryChange,
  options,
  loading,
  open,
  onOpenChange,
  activeIndex,
  onActiveIndex,
  onSelect,
  renderOption,
  optionKey,
  disabled,
  inputRef,
}: {
  label: string;
  step: string;
  placeholder: string;
  query: string;
  onQueryChange: (value: string) => void;
  options: T[];
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (option: T) => void;
  renderOption: (option: T) => { title: string; detail: string };
  optionKey: (option: T) => string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const listId = useId();
  const inputId = useId();
  const shown = options.slice(0, MAX_OPTIONS);
  const safeIndex = shown.length === 0 ? 0 : Math.min(activeIndex, shown.length - 1);
  const active = shown[safeIndex];

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onOpenChange(true);
      onActiveIndex(Math.min(activeIndex + 1, Math.max(shown.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onOpenChange(true);
      onActiveIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && active) onSelect(active);
    } else if (event.key === "Escape") {
      onOpenChange(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-medium tracking-wide text-teal-800">{step}</p>
        <label htmlFor={inputId} className="mt-1 block text-xl font-semibold tracking-tight text-neutral-950">
          {label}
        </label>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-500" aria-hidden />
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active ? `${listId}-${safeIndex}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            onOpenChange(true);
            onActiveIndex(0);
          }}
          onFocus={() => {
            if (!disabled) onOpenChange(true);
          }}
          onBlur={() => {
            window.setTimeout(() => onOpenChange(false), 120);
          }}
          onKeyDown={onKeyDown}
          className="h-12 w-full rounded-lg border border-neutral-300 bg-white pr-3 pl-9 text-base text-neutral-950 outline-none placeholder:text-neutral-500 focus-visible:border-teal-700 focus-visible:ring-3 focus-visible:ring-teal-700/30 disabled:bg-neutral-50 disabled:text-neutral-500"
        />
        {open && !disabled ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} results`}
            className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
          >
            {loading && shown.length === 0 ? (
              <li className="px-3 py-3 text-base text-neutral-600">Searching…</li>
            ) : shown.length === 0 ? (
              <li className="px-3 py-3 text-base text-neutral-600">No matches</li>
            ) : (
              shown.map((option, index) => {
                const view = renderOption(option);
                const selected = index === safeIndex;
                return (
                  <li key={optionKey(option)} id={`${listId}-${index}`} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={`flex min-h-11 w-full flex-col justify-center px-3 py-2 text-left ${selected ? "bg-teal-50" : "hover:bg-neutral-50"}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => onActiveIndex(index)}
                      onClick={() => onSelect(option)}
                    >
                      <span className="text-base font-medium text-neutral-950">{view.title}</span>
                      <span className="text-sm text-neutral-600">{view.detail}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function DoctorTool() {
  const [upcoming, setUpcoming] = useState<UpcomingRisk[] | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);
  const [switched, setSwitched] = useState<Set<string>>(() => new Set());

  const [patientQuery, setPatientQuery] = useState("");
  const [patientOptions, setPatientOptions] = useState<Patient[]>([]);
  const [patientOpen, setPatientOpen] = useState(false);
  const [patientLoading, setPatientLoading] = useState(false);
  const [patientActive, setPatientActive] = useState(0);
  const [patient, setPatient] = useState<Patient | null>(null);

  const [drugQuery, setDrugQuery] = useState("");
  const [drugOptions, setDrugOptions] = useState<DrugHit[]>([]);
  const [drugOpen, setDrugOpen] = useState(false);
  const [drugLoading, setDrugLoading] = useState(false);
  const [drugActive, setDrugActive] = useState(0);
  const [selectedDrug, setSelectedDrug] = useState<DrugHit | null>(null);

  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [prescribedRxcui, setPrescribedRxcui] = useState<string | null>(null);

  const drugInputRef = useRef<HTMLInputElement>(null);
  const checkRequest = useRef(0);
  const action = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancel = false;
    getUpcoming()
      .then((rows) => {
        if (!cancel) setUpcoming(rows);
      })
      .catch((error: unknown) => {
        if (!cancel) setUpcomingError(error instanceof Error ? error.message : "Could not load upcoming changes");
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!patientOpen) return;
    let cancel = false;
    const timer = window.setTimeout(() => {
      setPatientLoading(true);
      searchPatients(patientQuery)
        .then((rows) => {
          if (cancel) return;
          setPatientOptions(rows);
          setPatientActive(0);
        })
        .catch(() => {
          if (!cancel) setPatientOptions([]);
        })
        .finally(() => {
          if (!cancel) setPatientLoading(false);
        });
    }, 150);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [patientOpen, patientQuery]);

  useEffect(() => {
    if (!drugOpen || !patient) return;
    let cancel = false;
    const timer = window.setTimeout(() => {
      setDrugLoading(true);
      searchDrugs(patient.id, drugQuery)
        .then((rows) => {
          if (cancel) return;
          setDrugOptions(rows);
          setDrugActive(0);
        })
        .catch(() => {
          if (!cancel) setDrugOptions([]);
        })
        .finally(() => {
          if (!cancel) setDrugLoading(false);
        });
    }, 150);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [drugOpen, drugQuery, patient]);

  const atRisk = upcoming === null ? null : Math.max(0, upcoming.length - switched.size);

  function recordSwitch(patientId: string, rxcui: string) {
    setSwitched((current) => {
      const key = switchKey(patientId, rxcui);
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function clearPatient() {
    action.current += 1;
    checkRequest.current += 1;
    setPatient(null);
    setPatientQuery("");
    setSelectedDrug(null);
    setDrugQuery("");
    setDrugOptions([]);
    setCheck(null);
    setCheckError(null);
    setCheckLoading(false);
    setPrescribedRxcui(null);
  }

  function choosePatient(next: Patient) {
    action.current += 1;
    checkRequest.current += 1;
    setPatient(next);
    setPatientQuery("");
    setPatientOpen(false);
    setSelectedDrug(null);
    setDrugQuery("");
    setDrugOptions([]);
    setCheck(null);
    setCheckError(null);
    setCheckLoading(false);
    setPrescribedRxcui(null);
    window.setTimeout(() => drugInputRef.current?.focus(), 0);
  }

  async function runCheck(patientId: string, rxcui: string) {
    const requestId = ++checkRequest.current;
    setCheck(null);
    setCheckError(null);
    setCheckLoading(true);
    setPrescribedRxcui(null);
    try {
      const result = await checkDrug(patientId, rxcui);
      if (requestId !== checkRequest.current) return;
      setCheck(result);
      window.setTimeout(() => resultRef.current?.scrollIntoView({ block: "nearest" }), 0);
    } catch (error: unknown) {
      if (requestId !== checkRequest.current) return;
      setCheckError(error instanceof Error ? error.message : "Coverage check failed");
    } finally {
      if (requestId === checkRequest.current) setCheckLoading(false);
    }
  }

  function chooseDrug(drug: DrugHit) {
    if (!patient) return;
    action.current += 1;
    setSelectedDrug(drug);
    setDrugQuery(drug.displayName);
    setDrugOpen(false);
    void runCheck(patient.id, drug.rxcui);
  }

  async function openRisk(risk: UpcomingRisk) {
    const actionId = ++action.current;
    setPatientOpen(false);
    setDrugOpen(false);
    try {
      const hits = await searchPatients(risk.patientName);
      if (actionId !== action.current) return;
      const match = hits.find((item) => item.id === risk.patientId);
      if (!match) {
        setCheckError("That patient is not on the roster.");
        return;
      }
      setPatient(match);
      setPatientQuery("");
      setSelectedDrug({ rxcui: risk.rxcui, drugName: risk.drugName, displayName: risk.displayName });
      setDrugQuery(risk.displayName);
      void runCheck(match.id, risk.rxcui);
    } catch (error: unknown) {
      setCheckError(error instanceof Error ? error.message : "Could not open that patient");
    }
  }

  function prescribe(alternative: Alternative) {
    if (!patient || !check) return;
    recordSwitch(patient.id, check.coverage.rxcui);
    setPrescribedRxcui(alternative.rxcui);
  }

  const counterTone = atRisk === 0 ? "text-emerald-800" : "text-red-700";
  const counterRule = atRisk === 0 ? "border-l-emerald-600" : "border-l-red-600";

  return (
    <div className="min-h-full bg-white">
      <div className="h-1.5 bg-teal-700" />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium tracking-wide text-teal-800">Medicare Part D</p>
              <Link href="/dashboard" className="text-sm font-medium text-teal-800 underline-offset-4 hover:underline">
                Coverage dashboard
              </Link>
            </div>
            <h1 className="mt-3 max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-5xl">
              How many patients have I financially ruined?
            </h1>
          </div>
          <Card className={`w-full shrink-0 border-l-4 lg:w-72 ${atRisk === null ? "border-l-neutral-300" : counterRule}`}>
            <CardContent aria-live="polite" aria-atomic="true">
              <p className={`text-7xl font-semibold tabular-nums tracking-tight ${atRisk === null ? "text-neutral-300" : counterTone}`}>
                {atRisk === null ? "–" : atRisk}
              </p>
              <p className="text-lg text-neutral-800">{atRisk === 1 ? "patient at risk" : "patients at risk"}</p>
            </CardContent>
          </Card>
        </header>
        <p className="max-w-2xl text-sm leading-6 text-neutral-600">
          Every dollar amount is an estimate for a typical 30-day fill. Deductibles and coverage phases are not included.
        </p>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,13fr)_minmax(0,7fr)]">
          <section className="flex flex-col gap-8" aria-label="Coverage check">
            <div className="flex flex-col gap-3">
              {patient ? (
                <div>
                  <p className="text-sm font-medium tracking-wide text-teal-800">Step 1</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">Patient</h2>
                  <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 py-1 pr-1 pl-3">
                    <span className="min-w-0 text-sm text-neutral-800">
                      <span className="font-semibold text-neutral-950">{patient.name}</span>
                      <span className="text-neutral-600">
                        {" "}
                        · {patient.age} · {patient.language} · {patient.plan.planName}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200 focus-visible:ring-3 focus-visible:ring-teal-700 focus-visible:outline-none"
                      aria-label={`Clear ${patient.name}`}
                      onClick={clearPatient}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
              ) : (
                <ComboBox
                  label="Find a patient"
                  step="Step 1"
                  placeholder="Search by name"
                  query={patientQuery}
                  onQueryChange={(value) => {
                    setPatientQuery(value);
                    setPatientLoading(true);
                  }}
                  options={patientOptions}
                  loading={patientLoading}
                  open={patientOpen}
                  onOpenChange={(open) => {
                    setPatientOpen(open);
                    if (open) setPatientLoading(true);
                  }}
                  activeIndex={patientActive}
                  onActiveIndex={setPatientActive}
                  onSelect={choosePatient}
                  optionKey={(option) => option.id}
                  renderOption={(option) => ({
                    title: option.name,
                    detail: `${option.age} · ${option.plan.planName}`,
                  })}
                />
              )}
            </div>

            <div className={patient ? "flex flex-col gap-4" : "flex flex-col gap-4 opacity-60"}>
              <ComboBox
                label="Check a medication"
                step="Step 2"
                placeholder={patient ? "Search this patient's medications" : "Choose a patient first"}
                query={drugQuery}
                onQueryChange={(value) => {
                  setDrugQuery(value);
                  setDrugLoading(true);
                  if (selectedDrug && value !== selectedDrug.displayName) {
                    setSelectedDrug(null);
                    setCheck(null);
                    setCheckError(null);
                    setPrescribedRxcui(null);
                  }
                }}
                options={drugOptions}
                loading={drugLoading}
                open={drugOpen}
                onOpenChange={(open) => {
                  setDrugOpen(open);
                  if (open) setDrugLoading(true);
                }}
                activeIndex={drugActive}
                onActiveIndex={setDrugActive}
                onSelect={chooseDrug}
                optionKey={(option) => option.rxcui}
                disabled={!patient}
                inputRef={drugInputRef}
                renderOption={(option) => ({
                  title: option.displayName,
                  detail: option.drugName,
                })}
              />

              <div ref={resultRef}>
                {checkLoading ? (
                  <Card>
                    <CardContent className="text-base text-neutral-600" aria-busy="true">
                      Checking coverage…
                    </CardContent>
                  </Card>
                ) : null}
                {checkError ? (
                  <Alert className="border-red-200 bg-red-50 text-red-900">
                    <AlertTitle>Coverage check failed</AlertTitle>
                    <AlertDescription className="text-red-900/80">{checkError}</AlertDescription>
                  </Alert>
                ) : null}
                {check && selectedDrug ? (
                  <ResultCard
                    check={check}
                    prescribedRxcui={prescribedRxcui}
                    onPrescribe={prescribe}
                  />
                ) : null}
              </div>
            </div>
          </section>

          <aside className="flex flex-col gap-3 lg:sticky lg:top-4" aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="text-xl font-semibold tracking-tight text-balance text-neutral-950">
              At risk from upcoming plan changes (effective Jan 1, 2027)
            </h2>
            {upcomingError ? (
              <Alert className="border-red-200 bg-red-50 text-red-900">
                <AlertTitle>Upcoming changes could not be loaded</AlertTitle>
                <AlertDescription className="text-red-900/80">{upcomingError}</AlertDescription>
              </Alert>
            ) : upcoming === null ? (
              <Card>
                <CardContent className="text-base text-neutral-600">Loading upcoming changes…</CardContent>
              </Card>
            ) : upcoming.length === 0 ? (
              <Card>
                <CardContent className="text-base text-emerald-800">No upcoming plan changes.</CardContent>
              </Card>
            ) : (
              <ul className="flex flex-col gap-3">
                {upcoming.map((risk) => (
                  <li key={switchKey(risk.patientId, risk.rxcui)}>
                    <RiskCard
                      risk={risk}
                      resolved={switched.has(switchKey(risk.patientId, risk.rxcui))}
                      active={patient?.id === risk.patientId && selectedDrug?.rxcui === risk.rxcui}
                      onOpen={() => void openRisk(risk)}
                      onSwitch={() => recordSwitch(risk.patientId, risk.rxcui)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

function ResultCard({
  check,
  prescribedRxcui,
  onPrescribe,
}: {
  check: CheckResponse;
  prescribedRxcui: string | null;
  onPrescribe: (alternative: Alternative) => void;
}) {
  const coverage = check.coverage;
  const status = STATUS_STYLE[coverage.status];
  const alternatives = check.alternatives.slice(0, 3);
  const locked = prescribedRxcui !== null;

  return (
    <Card className={`border-l-4 ${status.rule}`}>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold text-neutral-950">{displayDrugName(coverage.drugName)}</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-950 tabular-nums">
              {estMoney(coverage.estMonthlyCost)}
              <span className="text-base font-medium text-neutral-600">/mo</span>
            </p>
          </div>
          <Badge className={`h-7 px-2.5 text-sm ${status.badge}`}>{status.label}</Badge>
        </div>
        {restrictionBadges(coverage)}
        <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
          <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Cheaper alternatives</h3>
          {alternatives.length === 0 ? (
            <p className="text-base font-semibold text-red-700">No safe cheaper option found</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {alternatives.map((alternative) => {
                const prescribed = prescribedRxcui === alternative.rxcui;
                return (
                  <li
                    key={alternative.rxcui}
                    className={`flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between ${prescribed ? "border-emerald-300 bg-emerald-50" : "border-neutral-200"}`}
                  >
                    <div className="min-w-0">
                      <p className="text-base font-medium text-neutral-950">{displayDrugName(alternative.drugName)}</p>
                      <p className="mt-0.5 text-sm text-neutral-700 tabular-nums">
                        {estMoney(alternative.estMonthlyCost)}/mo
                        <span className="text-emerald-800"> · saves {estMoney(alternative.monthlySavings)}/mo</span>
                      </p>
                      <div className="mt-2">{restrictionBadges(alternative)}</div>
                    </div>
                    <Button
                      type="button"
                      className="h-11 shrink-0 px-3"
                      disabled={locked}
                      onClick={() => onPrescribe(alternative)}
                    >
                      {prescribed ? (
                        <>
                          <Check aria-hidden />
                          Prescribed
                        </>
                      ) : (
                        "Prescribe this instead"
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RiskCard({
  risk,
  resolved,
  active,
  onOpen,
  onSwitch,
}: {
  risk: UpcomingRisk;
  resolved: boolean;
  active: boolean;
  onOpen: () => void;
  onSwitch: () => void;
}) {
  const alternative = risk.bestAlternative;
  return (
    <Card
      className={`border-l-4 ${resolved ? "border-l-emerald-600 bg-emerald-50/60" : "border-l-amber-500"} ${active ? "ring-2 ring-teal-700" : ""}`}
    >
      <CardContent className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-teal-700"
        >
          <span className="flex items-start justify-between gap-2">
            <span>
              <span className="block text-lg font-semibold text-neutral-950">{risk.patientName}</span>
              <span className="mt-0.5 block text-sm text-neutral-600">
                {risk.age} · {risk.language}
              </span>
            </span>
            {resolved ? (
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-800">
                <Check className="size-4" aria-hidden />
                Switched
              </span>
            ) : null}
          </span>
          <span className="mt-3 block text-base font-medium text-neutral-950">{risk.displayName}</span>
          <span className="mt-1 block text-base tabular-nums">
            <span className={resolved ? "text-neutral-500 line-through decoration-neutral-500" : "text-neutral-800"}>
              {estMoney(risk.oldMonthlyCost)}
            </span>
            <span className="text-neutral-500" aria-hidden>
              {" "}
              →{" "}
            </span>
            <span className={resolved ? "text-neutral-500 line-through decoration-neutral-500" : "font-semibold text-red-700"}>
              {estMoney(risk.newMonthlyCost)}
            </span>
            <span className={`ml-2 font-semibold ${resolved ? "text-neutral-500" : "text-red-700"}`}>
              {percentLabel(risk.percentIncrease)}
            </span>
          </span>
          {alternative ? (
            <span className="mt-2 block text-sm text-neutral-800">
              Switch to {displayDrugName(alternative.drugName)} · {estMoney(alternative.estMonthlyCost)}/mo · saves{" "}
              {estMoney(alternative.monthlySavings)}/mo
            </span>
          ) : (
            <span className="mt-2 block text-sm font-semibold text-red-700">No safe cheaper option found</span>
          )}
        </button>
        {resolved ? null : (
          <Button type="button" variant="outline" className="h-11 w-full" onClick={onSwitch}>
            Switch now
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
