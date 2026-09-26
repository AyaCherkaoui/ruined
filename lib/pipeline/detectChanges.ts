import crypto from "node:crypto";
import type { ChangeType } from "../contract";
import { getDb, type Db } from "../db";

// Every ADVERSE formulary change between two loaded data versions, for a given
// (formulary_id, rxcui): dropped from the formulary, moved to a higher tier, or newly
// requires PA / step therapy / a quantity limit. Persisted to coverage_changes (see
// DATA_MODEL.md). Improvements are not recorded -- this is "what a doctor needs to know
// changed for the worse," not a full diff.

export interface DetectedChange {
  id: string;
  fromVersion: string;
  toVersion: string;
  formularyId: string;
  rxcui: string;
  changeType: ChangeType;
  oldTier: number | null;
  newTier: number | null;
  oldPa: boolean;
  newPa: boolean;
  oldSt: boolean;
  newSt: boolean;
  oldQl: boolean;
  newQl: boolean;
  detectedAt: string;
}

interface DiffRow {
  formulary_id: string;
  rxcui: string;
  old_tier: number | null;
  new_tier: number | null;
  old_pa: boolean;
  new_pa: boolean;
  old_st: boolean;
  new_st: boolean;
  old_ql: boolean;
  new_ql: boolean;
}

interface ChangeDbRow extends DiffRow {
  id: string;
  from_version: string;
  to_version: string;
  change_type: ChangeType;
  detected_at: string;
}

/** Deterministic id from the natural key, so re-detecting the same change never duplicates it. */
function changeId(fromVersion: string, toVersion: string, formularyId: string, rxcui: string, changeType: string): string {
  return crypto.createHash("sha1").update([fromVersion, toVersion, formularyId, rxcui, changeType].join(":")).digest("hex").slice(0, 20);
}

function adverseTypes(r: DiffRow): ChangeType[] {
  const types: ChangeType[] = [];
  if (r.new_tier === null) types.push("removed");
  else if (r.old_tier !== null && r.new_tier > r.old_tier) types.push("tier_increase");
  if (!r.old_pa && r.new_pa) types.push("new_prior_auth");
  if (!r.old_st && r.new_st) types.push("new_step_therapy");
  if (!r.old_ql && r.new_ql) types.push("new_quantity_limit");
  return types;
}

const toDto = (r: ChangeDbRow): DetectedChange => ({
  id: r.id,
  fromVersion: r.from_version,
  toVersion: r.to_version,
  formularyId: r.formulary_id,
  rxcui: r.rxcui,
  changeType: r.change_type,
  oldTier: r.old_tier,
  newTier: r.new_tier,
  oldPa: r.old_pa,
  newPa: r.new_pa,
  oldSt: r.old_st,
  newSt: r.new_st,
  oldQl: r.old_ql,
  newQl: r.new_ql,
  detectedAt: r.detected_at,
});

/**
 * Diffs `fromVersion` -> `toVersion` (optionally scoped to `rxcuis`), upserts any newly-found
 * adverse changes into coverage_changes, and returns every matching row (old + new) so a rerun
 * with the same inputs always returns the same set without duplicating storage.
 */
export async function detectChanges(fromVersion: string, toVersion: string, rxcuis?: string[], db?: Db): Promise<DetectedChange[]> {
  const conn = db ?? (await getDb());
  const params: (string | number)[] = [fromVersion, toVersion];
  let rxcuiFilter = "";
  if (rxcuis && rxcuis.length > 0) {
    rxcuiFilter = ` AND a.rxcui IN (${rxcuis.map((_, i) => `$${params.length + i + 1}`).join(", ")})`;
    params.push(...rxcuis);
  }

  const diffRows = await conn.query<DiffRow>(
    `SELECT a.formulary_id, a.rxcui,
            a.tier AS old_tier, b.tier AS new_tier,
            a.prior_authorization AS old_pa, coalesce(b.prior_authorization, false) AS new_pa,
            a.step_therapy AS old_st, coalesce(b.step_therapy, false) AS new_st,
            a.quantity_limit AS old_ql, coalesce(b.quantity_limit, false) AS new_ql
       FROM formulary a
       LEFT JOIN formulary b ON b.data_version = $2 AND b.formulary_id = a.formulary_id AND b.rxcui = a.rxcui
      WHERE a.data_version = $1${rxcuiFilter}`,
    params,
  );

  const candidateIds: string[] = [];
  for (const r of diffRows) {
    for (const changeType of adverseTypes(r)) {
      const id = changeId(fromVersion, toVersion, r.formulary_id, r.rxcui, changeType);
      candidateIds.push(id);
      const existing = await conn.query<{ id: string }>("SELECT id FROM coverage_changes WHERE id = $1", [id]);
      if (existing.length > 0) continue;
      await conn.run(
        `INSERT INTO coverage_changes (id, from_version, to_version, formulary_id, rxcui, change_type,
            old_tier, new_tier, old_pa, new_pa, old_st, new_st, old_ql, new_ql, detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP)`,
        [id, fromVersion, toVersion, r.formulary_id, r.rxcui, changeType, r.old_tier, r.new_tier, r.old_pa, r.new_pa, r.old_st, r.new_st, r.old_ql, r.new_ql],
      );
    }
  }
  if (candidateIds.length === 0) return [];

  const rows = await conn.query<ChangeDbRow>(
    `SELECT * FROM coverage_changes WHERE id IN (${candidateIds.map((_, i) => `$${i + 1}`).join(", ")})
      ORDER BY rxcui, change_type`,
    candidateIds,
  );
  return rows.map(toDto);
}
