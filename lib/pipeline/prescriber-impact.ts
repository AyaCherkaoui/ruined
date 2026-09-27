import type { Db } from "../db";
import type { CoveragePlanKey, DoctorImpact, DoctorImpactQualityFlag } from "./aggregate-contract";
import { hash, planKey, stableId } from "./aggregate-store";
import { readChanges } from "./compare-snapshots";
import { fetchCmsPage, type HttpOptions } from "./source-http";

export interface CmsPrescriberRow {
  Prscrbr_NPI: string;
  Prscrbr_State_Abrvtn: string;
  Brnd_Name: string;
  Gnrc_Name: string;
  Tot_Clms: string | number | null;
  Tot_Benes?: string | number | null;
}
export interface PrescriberVolume {
  npi: string; sourceYear: number; drug: "apixaban";
  value: number | null; suppressed: boolean; missing: boolean;
  sourceField: "Tot_Clms"; sourceHash: string; sourceId: string;
  sourceNames: string[]; provenance: "replay" | "live" | "simulated";
}

export function normalizePrescriber(row: CmsPrescriberRow, sourceYear: number, sourceId: string, provenance: PrescriberVolume["provenance"]): PrescriberVolume | null {
  const brand = String(row.Brnd_Name ?? "").trim().toLowerCase();
  const generic = String(row.Gnrc_Name ?? "").trim().toLowerCase();
  if (String(row.Prscrbr_State_Abrvtn).trim().toUpperCase() !== "GA" || !(brand === "eliquis" || brand === "apixaban" || generic === "apixaban")) return null;
  if (!/^\d{10}$/.test(row.Prscrbr_NPI) || !Number.isInteger(sourceYear) || sourceYear < 2013) throw new Error("Invalid prescriber identity/year");
  const text = String(row.Tot_Clms ?? "").trim();
  const suppressed = ["*", "<11", "suppressed"].includes(text.toLowerCase());
  const missing = text === "";
  const value = suppressed || missing ? null : Number(text.replaceAll(",", ""));
  if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error("Invalid Tot_Clms");
  return { npi: row.Prscrbr_NPI, sourceYear, drug: "apixaban", value, suppressed, missing, sourceField: "Tot_Clms", sourceId,
    sourceHash: hash(JSON.stringify(row)), sourceNames: [brand, generic], provenance };
}

/** Streams prefiltered pages or JSONL; duplicates are not summed into inflated volume. */
export async function loadPrescriberVolumes(db: Db, rows: AsyncIterable<CmsPrescriberRow> | Iterable<CmsPrescriberRow>, sourceYear: number, sourceId: string, provenance: PrescriberVolume["provenance"] = "replay") {
  let loaded = 0;
  await db.run("BEGIN TRANSACTION");
  try {
    for await (const row of rows) {
      const volume = normalizePrescriber(row, sourceYear, sourceId, provenance);
      if (!volume) continue;
      const [existing] = await db.query<{ payload: string }>("SELECT payload FROM prescriber_drug_volume WHERE source_year=$1 AND npi=$2 AND drug=$3", [sourceYear, volume.npi, volume.drug]);
      if (existing) {
        const previous: PrescriberVolume = JSON.parse(existing.payload);
        if (previous.value !== volume.value || previous.suppressed !== volume.suppressed || previous.missing !== volume.missing || previous.sourceId !== volume.sourceId || previous.provenance !== volume.provenance) throw new Error(`Conflicting annual volume for ${volume.npi}; explicit reconciliation required`);
        continue;
      }
      await db.run("INSERT INTO prescriber_drug_volume VALUES ($1,$2,$3,$4)", [sourceYear, volume.npi, volume.drug, JSON.stringify(volume)]);
      loaded++;
    }
    await db.run("COMMIT");
  } catch (error) { await db.run("ROLLBACK"); throw error; }
  return loaded;
}

export async function* fetchPrescriberRows(datasetId: string, root = "data/raw/cms-prescribers", options: HttpOptions = {}): AsyncGenerator<CmsPrescriberRow> {
  if (!/^[a-f0-9-]{36}$/.test(datasetId)) throw new Error("Invalid CMS dataset id");
  const size = 1000;
  const pageHashes = new Set<string>();
  for (let page = 0; page < 1000; page++) {
    const url = new URL(`https://data.cms.gov/data-api/v1/dataset/${datasetId}/data`);
    url.searchParams.set("filter[Prscrbr_State_Abrvtn]", "GA");
    url.searchParams.set("filter[Gnrc_Name]", "Apixaban");
    url.searchParams.set("size", String(size));
    url.searchParams.set("offset", String(page * size));
    const rows = await fetchCmsPage(url.toString(), page + 1, root, options);
    if (!Array.isArray(rows)) throw new Error("CMS response must be an array");
    if (!rows.length) return;
    const digest = hash(JSON.stringify(rows));
    if (pageHashes.has(digest)) throw new Error("CMS pagination repeated a page");
    pageHashes.add(digest);
    for (const row of rows) yield row as CmsPrescriberRow;
    if (rows.length < size) return;
  }
  throw new Error("CMS pagination exceeded safety bound");
}

export async function declarePlanAcceptance(db: Db, npi: string, plan: CoveragePlanKey) {
  if (!/^\d{10}$/.test(npi)) throw new Error("Invalid NPI");
  await db.run("INSERT INTO provider_plan_acceptance VALUES ($1,$2,'demo_signup') ON CONFLICT DO NOTHING", [npi, planKey(plan)]);
}

export async function matchPrescriberImpacts(db: Db, sourceYear: number): Promise<DoctorImpact[]> {
  const changes = (await readChanges(db)).filter((c) => c.direction === "worsened" && !c.resolvedByChangeId);
  const volumes = (await db.query<{ payload: string }>("SELECT payload FROM prescriber_drug_volume WHERE source_year=$1 ORDER BY npi", [sourceYear])).map((r) => JSON.parse(r.payload) as PrescriberVolume);
  const acceptance = new Set((await db.query<{ npi: string; plan_key: string }>("SELECT npi, plan_key FROM provider_plan_acceptance WHERE source='demo_signup'")).map((r) => `${r.npi}:${r.plan_key}`));
  const impacts: DoctorImpact[] = [];
  await db.run("BEGIN TRANSACTION");
  try {
    for (const change of changes) for (const volume of volumes) {
      if (!acceptance.has(`${volume.npi}:${planKey(change.plan)}`) || volume.value === 0) continue;
      const qualityFlags: DoctorImpactQualityFlag[] = ["demo_plan_acceptance", "ingredient_level_volume", "not_plan_specific"];
      if (volume.suppressed) qualityFlags.push("suppressed_source_value");
      if (volume.missing) qualityFlags.push("missing_source_value");
      if (change.provenance === "simulated") qualityFlags.push("simulated_change");
      if (volume.provenance === "simulated") qualityFlags.push("simulated_source");
      if (volume.sourceNames[0] !== "eliquis") qualityFlags.push("source_name_normalized");
      if (Number(change.detectedAt.slice(0, 4)) - sourceYear > 2) qualityFlags.push("stale_source_year");
      const impact: DoctorImpact = { id: stableId(change.id, volume.npi, sourceYear, "total_claims"), npi: volume.npi, changeId: change.id, plan: change.plan, rxcui: change.rxcui,
        estimate: { metric: "total_claims", value: volume.value, lowerBound: null, upperBound: null, method: volume.suppressed ? "cms_suppressed" : volume.missing ? "derived_range" : "cms_reported_value" },
        sourceYear, suppressed: volume.suppressed, qualityFlags, planAcceptanceSource: "demo_signup" };
      await db.run("INSERT INTO doctor_impacts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [impact.id, change.id, JSON.stringify(impact)]);
      impacts.push(impact);
    }
    await db.run("COMMIT");
  } catch (error) { await db.run("ROLLBACK"); throw error; }
  return impacts.sort((a, b) => a.id.localeCompare(b.id));
}
