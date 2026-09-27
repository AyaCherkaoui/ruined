import type { InsurerCheck } from "./contract";
import type { PlanKey } from "./coverage";
import type { Db } from "./db";
import { CURRENT_DATA_VERSION, PLAN_YEAR } from "./scenario";

// Second source next to CMS: the insurer's own Da Vinci US Drug Formulary FHIR API.
// Humana is the only major insurer whose formulary API answers without credentials
// (Cigna and Elevance/Anthem require registration). This is a lookup, never a coverage decision.

export const HUMANA_FHIR = "https://fhir.humana.com/api";
export const HUMANA_SOURCE = "Humana Drug Formulary API (FHIR)";
const HUMANA_DOCS = "https://developers.humana.com/drug-formulary-api/doc";

// Humana caps a page at 100 and pages with _skip. A single NDC has ~1,500 records (every plan, 2025 + 2026).
const PAGE_SIZE = 100;
const MAX_RECORDS = 5000;
const MAX_NDCS = 4;
const TIMEOUT_MS = 10_000;
const CACHE_MS = 60 * 60 * 1000;

const EXT = {
  plan: "usdf-PlanID-extension",
  tier: "usdf-DrugTierID-extension",
  pa: "usdf-PriorAuthorization-extension",
  st: "usdf-StepTherapyLimit-extension",
  ql: "usdf-QuantityLimit-extension",
};

export interface HumanaRecord {
  planYearId: string;
  ndc: string;
  productName: string;
  tier: number | null;
  tierLabel: string | null;
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: boolean;
  lastUpdated: string | null;
}

interface FhirExtension {
  url?: string;
  valueBoolean?: boolean | null;
  valueString?: string;
  valueCodeableConcept?: { coding?: { code?: string; display?: string }[] };
}

interface FhirMedicationKnowledge {
  meta?: { lastUpdated?: string };
  code?: { coding?: { system?: string; code?: string; display?: string }[] };
  extension?: FhirExtension[];
}

interface FhirBundle {
  total?: number;
  entry?: { resource?: FhirMedicationKnowledge }[];
}

export function insurerForPlan(planName: string): "Humana" | null {
  return /\bhumana\b/i.test(planName) ? "Humana" : null;
}

/** Humana keys formulary plans as CONTRACT-PLAN-SEGMENT-YEAR, e.g. S5884-135-000-2026. */
export function humanaPlanYearId(plan: PlanKey, year = PLAN_YEAR): string {
  return `${plan.contractId}-${plan.planId}-${plan.segmentId}-${year}`;
}

export function parseHumanaRecord(resource: FhirMedicationKnowledge): HumanaRecord | null {
  const ext = (name: string) => resource.extension?.find((e) => e.url?.endsWith(`/${name}`));
  const planYearId = ext(EXT.plan)?.valueString;
  const coding = resource.code?.coding?.find((c) => c.system?.endsWith("/ndc11")) ?? resource.code?.coding?.[0];
  if (!planYearId || !coding?.code) return null;
  const tier = ext(EXT.tier)?.valueCodeableConcept?.coding?.[0];
  const tierNumber = tier?.code && /^\d+$/.test(tier.code) ? Number(tier.code) : null;
  return {
    planYearId,
    ndc: coding.code,
    productName: coding.display ?? coding.code,
    tier: tierNumber,
    tierLabel: tier?.display ?? null,
    priorAuth: ext(EXT.pa)?.valueBoolean === true,
    stepTherapy: ext(EXT.st)?.valueBoolean === true,
    quantityLimit: ext(EXT.ql)?.valueBoolean === true,
    lastUpdated: resource.meta?.lastUpdated ?? null,
  };
}

async function getBundle(url: string, fetchImpl: typeof fetch): Promise<FhirBundle> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/fhir+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Humana API returned ${response.status}`);
  return (await response.json()) as FhirBundle;
}

function recordsOf(bundle: FhirBundle): HumanaRecord[] {
  return (bundle.entry ?? [])
    .map((e) => (e.resource ? parseHumanaRecord(e.resource) : null))
    .filter((r): r is HumanaRecord => r !== null);
}

/** Every Humana formulary record for one NDC, across all plans and years. */
export async function humanaRecordsForNdc(ndc: string, fetchImpl: typeof fetch = fetch): Promise<HumanaRecord[]> {
  const url = (skip: number) =>
    `${HUMANA_FHIR}/MedicationKnowledge?${new URLSearchParams({ code: ndc, _count: String(PAGE_SIZE), _skip: String(skip) })}`;
  const first = await getBundle(url(0), fetchImpl);
  const total = first.total ?? first.entry?.length ?? 0;
  if (total > MAX_RECORDS) throw new Error(`Humana API returned ${total} records for NDC ${ndc}`);
  const skips: number[] = [];
  for (let skip = PAGE_SIZE; skip < total; skip += PAGE_SIZE) skips.push(skip);
  const rest = await Promise.all(skips.map((skip) => getBundle(url(skip), fetchImpl)));
  return [first, ...rest].flatMap(recordsOf);
}

const cache = new Map<string, { at: number; records: Promise<HumanaRecord[]> }>();

function cachedRecords(ndc: string, fetchImpl: typeof fetch): Promise<HumanaRecord[]> {
  const hit = cache.get(ndc);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.records;
  const records = humanaRecordsForNdc(ndc, fetchImpl);
  cache.set(ndc, { at: Date.now(), records });
  records.catch(() => cache.delete(ndc));
  return records;
}

export function clearHumanaCache(): void {
  cache.clear();
}

/** Ask Humana's API about this plan for each candidate NDC, in order; first plan match wins. */
export async function humanaCheck(
  plan: PlanKey,
  ndcs: string[],
  opts: { fetch?: typeof fetch; year?: number } = {},
): Promise<InsurerCheck> {
  const planYearId = humanaPlanYearId(plan, opts.year);
  const checked = ndcs.slice(0, MAX_NDCS);
  try {
    const perNdc = await Promise.all(checked.map((ndc) => cachedRecords(ndc, opts.fetch ?? fetch)));
    for (const records of perNdc) {
      const match = records.find((r) => r.planYearId === planYearId);
      if (match) {
        return { status: "listed", insurer: "Humana", ...match, source: HUMANA_SOURCE, sourceUrl: HUMANA_DOCS };
      }
    }
    return { status: "not_listed", insurer: "Humana", planYearId, ndcsChecked: checked, source: HUMANA_SOURCE, sourceUrl: HUMANA_DOCS };
  } catch (err: unknown) {
    const message = err instanceof Error && err.name !== "TimeoutError" ? err.message : "Humana API did not respond in time";
    return { status: "unavailable", insurer: "Humana", error: message, source: HUMANA_SOURCE };
  }
}

/**
 * Candidate NDCs for a drug: the one CMS lists on this plan's formulary first, then the NDCs other
 * formularies use for the same RXCUI (an insurer may file the drug under a different package).
 */
export async function ndcsForPlanDrug(db: Db, plan: PlanKey, rxcui: string): Promise<string[]> {
  const rows = await db.query<{ ndc: string; own: boolean }>(
    `SELECT f.ndc, bool_or(pl.contract_id IS NOT NULL) AS own
       FROM formulary f
       LEFT JOIN plans pl ON pl.data_version = f.data_version AND pl.formulary_id = f.formulary_id
                         AND pl.contract_id = $2 AND pl.plan_id = $3 AND pl.segment_id = $4
      WHERE f.rxcui = $1 AND f.data_version IN ($5, 'v1')
      GROUP BY f.ndc
      ORDER BY own DESC, count(*) DESC, f.ndc
      LIMIT ${MAX_NDCS}`,
    [rxcui, plan.contractId, plan.planId, plan.segmentId, CURRENT_DATA_VERSION],
  );
  return rows.map((r) => r.ndc);
}

export async function insurerCheck(
  db: Db,
  plan: PlanKey,
  planName: string,
  rxcui: string,
  opts: { fetch?: typeof fetch; year?: number } = {},
): Promise<InsurerCheck> {
  if (insurerForPlan(planName) !== "Humana") return { status: "unsupported", planName };
  const ndcs = await ndcsForPlanDrug(db, plan, rxcui);
  if (ndcs.length === 0) {
    return { status: "not_listed", insurer: "Humana", planYearId: humanaPlanYearId(plan, opts.year), ndcsChecked: [], source: HUMANA_SOURCE, sourceUrl: HUMANA_DOCS };
  }
  return humanaCheck(plan, ndcs, opts);
}
