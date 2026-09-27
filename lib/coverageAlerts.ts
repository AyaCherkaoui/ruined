import type {
  ChangeType,
  CoverageAlert,
  CoverageAlertAction,
  CoverageAlertChangeType,
  EstimatedPatientRange,
} from "./contract";
import { requireUser } from "./auth";
import { loadDemoCoverageChanges } from "./demoCoverageAlerts";
import { ApiError } from "./http";
import type { CoverageChangeFactType } from "./pipeline/aggregate-contract";
import { supabaseConfigured } from "./supabase/server";
import { createSupabaseCoverageAlertStore } from "./supabaseCoverageAlerts";

// Coverage Watchdog alerts: data source -> this service -> /api/alerts -> frontend.
//
// A data source only returns CoverageChangeInput rows (what changed). This file owns
// everything else: translating pipeline change names, the display summary, the action
// steps, and open/resolved state. With Supabase configured, alerts and each doctor's resolved
// state live in Supabase Postgres (lib/supabaseCoverageAlerts.ts); otherwise in-memory demo
// data is used. Routes and frontend are the same either way.

// ---------------------------------------------------------------------------------
// The integration point for Person 3
// ---------------------------------------------------------------------------------

/** One detected coverage change, as a data source provides it. */
export interface CoverageChangeInput {
  /** Stable across reruns, so a resolved alert stays resolved. E.g. a hash of plan + rxcui + changeType + snapshot. */
  id: string;
  insurer: string;
  /** CMS contract-plan id, e.g. "S5884-135". */
  planId: string;
  planName: string;
  /** Display name, e.g. "Eliquis (apixaban) 5 mg tablet". */
  drug: string;
  rxcui: string | null;
  /** An API name ("prior_auth_added") or a pipeline name ("new_prior_auth", "prior_authorization_added"). */
  changeType: CoverageAlertChangeType | ChangeType | CoverageChangeFactType;
  /** Human-readable rule before, e.g. "Tier 3. No prior authorization." Null if there was none. */
  oldValue: string | null;
  /** Human-readable rule after. Null if the drug is no longer covered. */
  newValue: string | null;
  /** YYYY-MM-DD, or null when the source has no effective date. */
  effectiveDate: string | null;
  /** ISO timestamp of when the change was detected. */
  detectedAt: string;
  /** Human-readable, e.g. "Humana formulary API, snapshot 2026-09-26". */
  source: string;
  sourceUrl: string | null;
  /** Only when CMS prescriber matching exists. Omit otherwise. */
  estimatedPatientRange?: EstimatedPatientRange | null;
  /** True only for simulated data. Omit for real data. */
  isDemo?: boolean;
}

export type LoadCoverageChanges = () => Promise<CoverageChangeInput[]>;

// ---------------------------------------------------------------------------------
// CoverageChangeInput -> CoverageAlert
// ---------------------------------------------------------------------------------

const CHANGE_TYPES: readonly CoverageAlertChangeType[] = [
  "prior_auth_added",
  "prior_auth_removed",
  "step_therapy_added",
  "step_therapy_removed",
  "quantity_limit_added",
  "quantity_limit_removed",
  "tier_increase",
  "tier_decrease",
  "dropped",
  "restored",
];

/**
 * Pipeline names -> API names: lib/pipeline/detectChanges (ChangeType) and the Eliquis
 * aggregate contract (CoverageChangeFactType). quantity_limit_tightened / _relaxed have no API
 * equivalent yet, so they are rejected rather than mislabeled.
 */
const PIPELINE_CHANGE_TYPES: Partial<Record<ChangeType | CoverageChangeFactType, CoverageAlertChangeType>> = {
  removed: "dropped",
  tier_increase: "tier_increase",
  new_prior_auth: "prior_auth_added",
  new_step_therapy: "step_therapy_added",
  new_quantity_limit: "quantity_limit_added",
  coverage_removed: "dropped",
  coverage_restored: "restored",
  tier_increased: "tier_increase",
  tier_decreased: "tier_decrease",
  prior_authorization_added: "prior_auth_added",
  prior_authorization_removed: "prior_auth_removed",
};

/** Throws on an unknown name, so a pipeline typo fails loudly instead of reaching the UI. */
export function normalizeChangeType(value: string): CoverageAlertChangeType {
  if ((CHANGE_TYPES as readonly string[]).includes(value)) return value as CoverageAlertChangeType;
  const mapped = PIPELINE_CHANGE_TYPES[value as ChangeType | CoverageChangeFactType];
  if (!mapped) throw new Error(`Unknown coverage change type "${value}"`);
  return mapped;
}

function summaryFor(type: CoverageAlertChangeType, plan: string, drug: string): string {
  switch (type) {
    case "prior_auth_added": return `${plan} now requires prior authorization for ${drug}.`;
    case "prior_auth_removed": return `${plan} no longer requires prior authorization for ${drug}.`;
    case "step_therapy_added": return `${plan} now requires step therapy for ${drug}.`;
    case "step_therapy_removed": return `${plan} no longer requires step therapy for ${drug}.`;
    case "quantity_limit_added": return `${plan} now limits the quantity covered for ${drug}.`;
    case "quantity_limit_removed": return `${plan} removed its quantity limit for ${drug}.`;
    case "tier_increase": return `${plan} moved ${drug} to a higher cost-sharing tier, so patients will likely pay more.`;
    case "tier_decrease": return `${plan} moved ${drug} to a lower cost-sharing tier.`;
    case "dropped": return `${plan} no longer covers ${drug}.`;
    case "restored": return `${plan} covers ${drug} again.`;
  }
}

function actionsFor(type: CoverageAlertChangeType, c: CoverageChangeInput): CoverageAlertAction[] {
  const findPatients: CoverageAlertAction = {
    type: "find_affected_patients",
    title: "Find affected patients in your own records",
    steps: [
      `Search your EHR for active ${c.drug} prescriptions.`,
      `Keep patients whose Part D plan is ${c.planName} (${c.planId}).`,
      c.effectiveDate
        ? `Start with anyone whose next refill falls on or after ${c.effectiveDate}.`
        : "Start with anyone whose next refill is soonest.",
    ],
    url: null,
  };
  const costSupport: CoverageAlertAction = {
    type: "cost_support",
    title: "Point patients to cost support",
    steps: [
      "Manufacturer copay cards generally cannot be used with Medicare Part D.",
      "Patients with limited income may qualify for Extra Help (the Part D Low-Income Subsidy) or a manufacturer patient assistance program.",
    ],
    url: null,
  };
  const exception = (title: string, steps: string[]): CoverageAlertAction => ({
    type: "request_exception",
    title,
    steps: [...steps, "Include a supporting statement from the prescriber."],
    url: null,
  });

  switch (type) {
    case "prior_auth_added":
      return [
        findPatients,
        {
          type: "submit_prior_auth",
          title: "Submit prior authorization before the next refill",
          steps: [
            `Send a prior authorization (coverage determination) request to ${c.insurer} for each affected patient.`,
            "Include the diagnosis and any history the plan's criteria ask for.",
            "Part D plans decide standard requests within 72 hours and expedited requests within 24 hours.",
          ],
          url: null,
        },
      ];
    case "step_therapy_added":
      return [
        findPatients,
        exception("Document prior therapy or request a step therapy exception", [
          "Check whether each patient has already tried the drugs the plan requires first.",
          `If so, or if those drugs are not appropriate, request a step therapy exception from ${c.insurer}.`,
        ]),
      ];
    case "quantity_limit_added":
      return [
        findPatients,
        exception("Check doses against the new quantity limit", [
          "Compare each patient's prescribed quantity with the plan's new limit.",
          `If a patient needs more, request a quantity limit exception from ${c.insurer}.`,
        ]),
      ];
    case "tier_increase":
      return [
        findPatients,
        exception("Request a tiering exception", [
          `Ask ${c.insurer} for a tiering exception so the patient pays the lower tier's cost share.`,
        ]),
        costSupport,
      ];
    case "dropped":
      return [
        findPatients,
        exception("Request a formulary exception", [
          `Ask ${c.insurer} for a formulary exception so the plan keeps covering ${c.drug} for patients who need it.`,
          "If an exception is not appropriate, review the plan's covered alternatives with the patient.",
        ]),
        costSupport,
      ];
    default:
      // The change helps patients. Nothing for the doctor to do.
      return [];
  }
}

export function buildCoverageAlert(input: CoverageChangeInput, resolvedAt: string | null): CoverageAlert {
  const changeType = normalizeChangeType(input.changeType);
  return {
    id: input.id,
    insurer: input.insurer,
    planId: input.planId,
    planName: input.planName,
    drug: input.drug,
    rxcui: input.rxcui,
    changeType,
    summary: summaryFor(changeType, input.planName, input.drug),
    oldValue: input.oldValue,
    newValue: input.newValue,
    effectiveDate: input.effectiveDate,
    detectedAt: input.detectedAt,
    estimatedPatientRange: input.estimatedPatientRange ?? null,
    status: resolvedAt ? "resolved" : "open",
    resolvedAt,
    isDemo: input.isDemo ?? false,
    source: input.source,
    sourceUrl: input.sourceUrl,
    actions: actionsFor(changeType, input),
  };
}

// ---------------------------------------------------------------------------------
// Store: a loader plus open/resolved state
// ---------------------------------------------------------------------------------

export interface CoverageAlertStore {
  list(): Promise<CoverageAlert[]>;
  get(id: string): Promise<CoverageAlert | null>;
  /** Idempotent: resolving a resolved alert keeps its original resolvedAt. Null if unknown id. */
  resolve(id: string): Promise<CoverageAlert | null>;
  /** Reopens every alert (demo reset). */
  reset(): Promise<void>;
}

/**
 * Resolved state is kept in memory, keyed by change id: it is lost on server restart.
 * Fine for the demo. A shared deployment would move it to a small database table.
 */
export function createCoverageAlertStore(load: LoadCoverageChanges, now: () => Date = () => new Date()): CoverageAlertStore {
  const resolvedAt = new Map<string, string>();

  async function changes(): Promise<CoverageChangeInput[]> {
    const rows = await load();
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error(`Duplicate coverage change id "${row.id}"`);
      seen.add(row.id);
    }
    return rows;
  }

  const build = (c: CoverageChangeInput) => buildCoverageAlert(c, resolvedAt.get(c.id) ?? null);
  const find = async (id: string) => (await changes()).find((c) => c.id === id);

  return {
    async list() {
      return (await changes()).map(build);
    },
    async get(id) {
      const change = await find(id);
      return change ? build(change) : null;
    },
    async resolve(id) {
      const change = await find(id);
      if (!change) return null;
      if (!resolvedAt.has(id)) resolvedAt.set(id, now().toISOString());
      return build(change);
    },
    async reset() {
      resolvedAt.clear();
    },
  };
}

// The in-memory demo store: one per server process (survives dev-server HMR, like getDb in lib/db.ts).
const g = globalThis as unknown as { __coverageAlertStore?: CoverageAlertStore };

export function coverageAlertStore(): CoverageAlertStore {
  return (g.__coverageAlertStore ??= createCoverageAlertStore(loadDemoCoverageChanges));
}

/**
 * The store for the current request. Checks the session first: when Supabase is configured,
 * nobody signed out gets past this (401), whichever store is used.
 * COVERAGE_ALERTS_SOURCE: "supabase" (default when Supabase is configured) or "demo".
 */
export async function requestCoverageAlertStore(): Promise<CoverageAlertStore> {
  const session = await requireUser();
  const kind = process.env.COVERAGE_ALERTS_SOURCE || (supabaseConfigured() ? "supabase" : "demo");
  if (kind === "demo") return coverageAlertStore();
  if (kind === "supabase") {
    if (!session) throw new ApiError(500, "COVERAGE_ALERTS_SOURCE=supabase needs the Supabase URL and publishable key in .env.local");
    return createSupabaseCoverageAlertStore(session);
  }
  throw new ApiError(500, `Unknown COVERAGE_ALERTS_SOURCE "${kind}". Supported: demo, supabase`);
}

// ---------------------------------------------------------------------------------
// Service: what the API routes call
// ---------------------------------------------------------------------------------

function requireId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new ApiError(400, "Alert id is required");
  return trimmed;
}

/** Newest detection first, ties by id, so the order is stable whatever the source. */
export async function listAlerts(store?: CoverageAlertStore): Promise<CoverageAlert[]> {
  const alerts = await (store ?? (await requestCoverageAlertStore())).list();
  return alerts.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || a.id.localeCompare(b.id));
}

export async function getAlert(id: string, store?: CoverageAlertStore): Promise<CoverageAlert> {
  const alert = await (store ?? (await requestCoverageAlertStore())).get(requireId(id));
  if (!alert) throw new ApiError(404, `Alert ${id} not found`);
  return alert;
}

export async function resolveAlert(id: string, store?: CoverageAlertStore): Promise<CoverageAlert> {
  const alert = await (store ?? (await requestCoverageAlertStore())).resolve(requireId(id));
  if (!alert) throw new ApiError(404, `Alert ${id} not found`);
  return alert;
}

export async function resetAlerts(store?: CoverageAlertStore): Promise<void> {
  await (store ?? (await requestCoverageAlertStore())).reset();
}
