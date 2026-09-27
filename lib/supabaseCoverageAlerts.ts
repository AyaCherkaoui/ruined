import type { Session } from "./auth";
import { buildCoverageAlert, normalizeChangeType, type CoverageAlertStore, type CoverageChangeInput } from "./coverageAlerts";
import { ApiError } from "./http";

// Coverage alerts in Supabase Postgres (supabase/migrations/20260927000000_coverage_alerts.sql).
// coverage_alerts holds the changes; coverage_alert_resolutions holds each signed-in doctor's
// own resolved state. Every query runs as the signed-in doctor, so row level security applies.

/** A coverage_alerts row. Person 3's pipeline inserts rows of this shape (see changeInputToRow). */
export interface CoverageAlertRow {
  id: string;
  insurer: string;
  plan_id: string;
  plan_name: string;
  drug: string;
  rxcui: string | null;
  change_type: string;
  old_value: string | null;
  new_value: string | null;
  effective_date: string | null;
  detected_at: string;
  source: string;
  source_url: string | null;
  estimated_patients_min: number | null;
  estimated_patients_max: number | null;
  estimated_patients_basis: string | null;
  is_demo: boolean;
}

interface ResolutionRow {
  alert_id: string;
  resolved_at: string;
}

const iso = (value: string) => new Date(value).toISOString();

export function rowToChangeInput(row: CoverageAlertRow): CoverageChangeInput {
  const hasEstimate =
    row.estimated_patients_min !== null && row.estimated_patients_max !== null && row.estimated_patients_basis !== null;
  return {
    id: row.id,
    insurer: row.insurer,
    planId: row.plan_id,
    planName: row.plan_name,
    drug: row.drug,
    rxcui: row.rxcui,
    changeType: normalizeChangeType(row.change_type),
    oldValue: row.old_value,
    newValue: row.new_value,
    effectiveDate: row.effective_date,
    detectedAt: iso(row.detected_at),
    source: row.source,
    sourceUrl: row.source_url,
    estimatedPatientRange: hasEstimate
      ? { min: row.estimated_patients_min!, max: row.estimated_patients_max!, basis: row.estimated_patients_basis! }
      : null,
    isDemo: row.is_demo,
  };
}

/**
 * For Person 3: turns a detected change into a coverage_alerts row. Translates pipeline change
 * names (e.g. "new_prior_auth", "coverage_removed") to the API names the table accepts, and
 * throws on anything it cannot translate.
 */
export function changeInputToRow(input: CoverageChangeInput): CoverageAlertRow {
  const range = input.estimatedPatientRange ?? null;
  return {
    id: input.id,
    insurer: input.insurer,
    plan_id: input.planId,
    plan_name: input.planName,
    drug: input.drug,
    rxcui: input.rxcui,
    change_type: normalizeChangeType(input.changeType),
    old_value: input.oldValue,
    new_value: input.newValue,
    effective_date: input.effectiveDate,
    detected_at: iso(input.detectedAt),
    source: input.source,
    source_url: input.sourceUrl,
    estimated_patients_min: range?.min ?? null,
    estimated_patients_max: range?.max ?? null,
    estimated_patients_basis: range?.basis ?? null,
    is_demo: input.isDemo ?? false,
  };
}

function check(error: { code?: string; message: string } | null, what: string): void {
  if (!error) return;
  // PGRST205 / 42P01: the tables do not exist yet.
  if (error.code === "PGRST205" || error.code === "42P01") {
    throw new ApiError(503, "Coverage alert tables are missing. Run supabase/migrations/20260927000000_coverage_alerts.sql in the Supabase SQL Editor.");
  }
  throw new Error(`Supabase ${what} failed: ${error.message}`);
}

export function createSupabaseCoverageAlertStore({ supabase, user }: Session): CoverageAlertStore {
  async function resolutionsFor(alertId?: string): Promise<Map<string, string>> {
    let query = supabase.from("coverage_alert_resolutions").select("alert_id, resolved_at").eq("user_id", user.id);
    if (alertId) query = query.eq("alert_id", alertId);
    const { data, error } = await query;
    check(error, "reading resolutions");
    return new Map(((data ?? []) as ResolutionRow[]).map((r) => [r.alert_id, iso(r.resolved_at)]));
  }

  async function get(id: string) {
    const { data, error } = await supabase.from("coverage_alerts").select("*").eq("id", id).maybeSingle();
    check(error, "reading an alert");
    if (!data) return null;
    const resolved = await resolutionsFor(id);
    return buildCoverageAlert(rowToChangeInput(data as CoverageAlertRow), resolved.get(id) ?? null);
  }

  return {
    async list() {
      const [alerts, resolved] = await Promise.all([supabase.from("coverage_alerts").select("*"), resolutionsFor()]);
      check(alerts.error, "reading alerts");
      return ((alerts.data ?? []) as CoverageAlertRow[]).map((row) =>
        buildCoverageAlert(rowToChangeInput(row), resolved.get(row.id) ?? null),
      );
    },
    get,
    async resolve(id) {
      const alert = await get(id);
      if (!alert || alert.status === "resolved") return alert;
      // ON CONFLICT DO NOTHING keeps the first resolved_at if two requests race.
      const { error } = await supabase
        .from("coverage_alert_resolutions")
        .upsert({ user_id: user.id, alert_id: id }, { onConflict: "user_id,alert_id", ignoreDuplicates: true });
      check(error, "resolving an alert");
      return get(id);
    },
    async reset() {
      const { error } = await supabase.from("coverage_alert_resolutions").delete().eq("user_id", user.id);
      check(error, "reopening alerts");
    },
  };
}
