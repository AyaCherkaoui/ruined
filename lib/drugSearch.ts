import type { DrugOption } from "./contract";
import { DEFAULT_DATA_VERSION, loadPlanContext, type PlanKey } from "./coverage";
import { getDb, type Db } from "./db";
import { displayDrugName } from "./display";

// Drug-name search scoped to one plan's formulary (so results are always things the plan actually
// covers). Kept in its own module, not lib/drugs.ts: drugs.ts is a base module coverage.ts depends
// on, and this needs loadPlanContext from coverage.ts -- importing it back into drugs.ts would be circular.

export const MAX_DRUG_SEARCH = 10;

export interface DrugSearchOptions {
  db?: Db;
  limit?: number;
  dataVersion?: string;
}

/** Formulary drugs on `plan` whose RxNorm name contains `query` (case-insensitive), capped at `limit` (default 10). */
export async function searchPlanDrugs(plan: PlanKey, query: string, opts: DrugSearchOptions = {}): Promise<DrugOption[]> {
  const q = query.trim();
  if (!q) return [];
  const db = opts.db ?? (await getDb());
  const limit = Math.max(0, Math.trunc(opts.limit ?? MAX_DRUG_SEARCH));
  const ctx = await loadPlanContext(db, plan, opts.dataVersion ?? DEFAULT_DATA_VERSION);

  const rows = await db.query<{ rxcui: string; name: string }>(
    `SELECT DISTINCT d.rxcui, d.name
       FROM formulary f JOIN drugs d ON d.rxcui = f.rxcui
      WHERE f.data_version = $1 AND f.formulary_id = $2 AND d.name ILIKE $3
      ORDER BY d.name
      LIMIT ${limit}`,
    [ctx.dataVersion, ctx.formularyId, `%${q}%`],
  );
  return rows.map((r) => ({ rxcui: r.rxcui, drugName: r.name, displayName: displayDrugName(r.name) }));
}
