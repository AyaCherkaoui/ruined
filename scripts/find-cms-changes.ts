/**
 * Scan our 16 roster plans' formularies for every REAL adverse change between v1 (Q2 2026
 * quarterly) and v2-cms (September 2026 monthly), independent of which drugs our current
 * patients happen to take -- used to pick realistic reassignment candidates for task 1
 * ("if fewer than 4 patients are affected, re-assign meds ... so they take drugs that really
 * changed"). Prints candidates already in our warmed drug cache (so no new RxNav calls needed),
 * oral tablets only (matches the roster's existing generics), tier-increase or newly-restricted,
 * cheapest-tier-before first (more likely to look like "a common generic got worse").
 */
import { openDb } from "../lib/db";

const PLANS = [
  ["S5884", "135"], ["S4802", "082"], ["S5921", "392"], ["S5921", "355"], ["S5601", "020"],
  ["H0439", "006"], ["H0111", "001"], ["H1109", "005"], ["H4141", "015"], ["H5216", "073"],
  ["H1889", "013"], ["H4036", "030"], ["H7917", "040"], ["H5141", "026"], ["H5453", "001"], ["H1170", "002"],
] as const;

async function main() {
  const db = await openDb();
  for (const [contractId, planId] of PLANS) {
    const rows = await db.query<{
      contract_id: string; plan_id: string; plan_name: string; rxcui: string; name: string;
      dose_form_group: string | null; class_name: string | null;
      old_tier: number | null; new_tier: number | null;
      old_pa: boolean; new_pa: boolean; old_st: boolean; new_st: boolean; old_ql: boolean; new_ql: boolean;
    }>(
      `WITH p1 AS (SELECT formulary_id, plan_name FROM plans WHERE data_version='v1' AND contract_id=$1 AND plan_id=$2 AND segment_id='000'),
            p2 AS (SELECT formulary_id FROM plans WHERE data_version='v2-cms' AND contract_id=$1 AND plan_id=$2 AND segment_id='000')
       SELECT p1.plan_name, f1.rxcui, d.name, d.dose_form_group, d.class_name,
              f1.tier AS old_tier, f2.tier AS new_tier,
              f1.prior_authorization AS old_pa, coalesce(f2.prior_authorization, false) AS new_pa,
              f1.step_therapy AS old_st, coalesce(f2.step_therapy, false) AS new_st,
              f1.quantity_limit AS old_ql, coalesce(f2.quantity_limit, false) AS new_ql
         FROM p1, p2
         JOIN formulary f1 ON f1.data_version='v1' AND f1.formulary_id=p1.formulary_id
         LEFT JOIN formulary f2 ON f2.data_version='v2-cms' AND f2.formulary_id=p2.formulary_id AND f2.rxcui=f1.rxcui
         JOIN drugs d ON d.rxcui = f1.rxcui
        WHERE d.dose_form_group = 'Oral Product' AND d.tty = 'SCD'
          AND ( (f2.rxcui IS NULL)
             OR (f2.tier IS NOT NULL AND f1.tier IS NOT NULL AND f2.tier > f1.tier)
             OR (NOT f1.prior_authorization AND f2.prior_authorization)
             OR (NOT f1.step_therapy AND f2.step_therapy)
             OR (NOT f1.quantity_limit AND f2.quantity_limit) )
        ORDER BY f1.tier, d.name`,
      [contractId, planId],
    );
    if (rows.length === 0) continue;
    console.log(`\n=== ${contractId}-${planId} ${rows[0].plan_name} (${rows.length} candidates) ===`);
    for (const r of rows.slice(0, 15)) {
      const type = r.new_tier === null && r.old_tier !== null
        ? "removed"
        : r.new_tier !== null && r.old_tier !== null && r.new_tier > r.old_tier
        ? `tier ${r.old_tier}->${r.new_tier}`
        : [!r.old_pa && r.new_pa && "new_pa", !r.old_st && r.new_st && "new_st", !r.old_ql && r.new_ql && "new_ql"].filter(Boolean).join(",");
      console.log(`  ${r.rxcui} ${r.name.slice(0, 50).padEnd(50)} [${r.class_name ?? "?"}] ${type}`);
    }
  }
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
