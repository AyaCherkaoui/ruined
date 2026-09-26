/**
 * Build data_version 'v2': a SYNTHETIC copy of the real v1 (CMS Q2 2026) data in which a few drugs our
 * seed patients take move to a higher formulary tier. It exists to demo the change tracker
 * (lib/changes.ts, GET /api/alerts); it is not CMS data and is labeled as synthetic in data_versions.
 *
 *   npx tsx scripts/make-v2.ts            # run after seeding patients (scripts/seed-patients.ts)
 *
 * Which changes (deterministic):
 *  1-5. the patients' meds with the highest estimated monthly cost, at most one per patient and per
 *       (formulary, drug): bumped to the nearest higher tier that (a) every plan on that formulary has a
 *       cost row for and (b) actually raises what that patient pays.
 *  6.   the (formulary, drug) taken by the most patients (a common generic), bumped one tier: one formulary
 *       change that hits several patients, to exercise the patient matching.
 * Stop the dev server first: DuckDB allows one writer.
 */
import { openDb, type Db } from "../lib/db";
import { coverageForRxcuis, DEFAULT_DATA_VERSION, loadPlanContext } from "../lib/coverage";
import { listPatients } from "../lib/patients";

const TABLES = ["plans", "formulary", "beneficiary_cost", "pricing"] as const;
const MAX_CHANGES = 5; // cost-driven changes; plus one shared-drug change
const V1 = DEFAULT_DATA_VERSION;
const V2 = "v2";

async function copyVersion(db: Db) {
  for (const table of TABLES) {
    const cols = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'main' AND table_name = $1 AND column_name <> 'data_version'
          ORDER BY ordinal_position`,
        [table],
      )
    ).map((c) => c.column_name);
    await db.run(`DELETE FROM ${table} WHERE data_version = $1`, [V2]);
    await db.run(
      `INSERT INTO ${table} (data_version, ${cols.join(", ")}) SELECT $1, ${cols.join(", ")} FROM ${table} WHERE data_version = $2`,
      [V2, V1],
    );
    const [a] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE data_version = $1`, [V1]);
    const [b] = await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE data_version = $1`, [V2]);
    if (a.n !== b.n) throw new Error(`${table}: v1 has ${a.n} rows but v2 copy has ${b.n}`);
    console.log(`copied ${table}: ${b.n.toLocaleString()} rows`);
  }
}

/** Nearest tier above `oldTier` that every plan on the formulary has a cost row for, or null. */
async function nextPricedTier(db: Db, formularyId: string, oldTier: number): Promise<number | null> {
  const plans = await db.query<{ contract_id: string; plan_id: string; segment_id: string }>(
    "SELECT contract_id, plan_id, segment_id FROM plans WHERE data_version = $1 AND formulary_id = $2",
    [V1, formularyId],
  );
  const contexts = [];
  for (const pl of plans) {
    contexts.push(await loadPlanContext(db, { contractId: pl.contract_id, planId: pl.plan_id, segmentId: pl.segment_id }, V1));
  }
  for (let tier = oldTier + 1; tier <= 6; tier++) if (contexts.every((c) => c.costByTier.has(tier))) return tier;
  return null;
}

async function main() {
  const db = await openDb();
  const patients = await listPatients(db);
  if (patients.length === 0) throw new Error("No patients found. Run scripts/seed-patients.ts first.");

  await copyVersion(db);

  // Candidate (patient, med) pairs with their v1 cost, most expensive first
  const candidates: { patientName: string; patientId: string; rxcui: string; drugName: string; formularyId: string; tier: number; cost: number; plan: (typeof patients)[number]["plan"] }[] = [];
  for (const p of patients) {
    const ctx = await loadPlanContext(db, p.plan, V1);
    const cov = await coverageForRxcuis(db, ctx, p.meds.map((m) => m.rxcui));
    for (const m of p.meds) {
      const c = cov.get(m.rxcui)!;
      if (c.tier !== null && c.estMonthlyCost !== null) {
        candidates.push({ patientName: p.name, patientId: p.id, rxcui: m.rxcui, drugName: c.drugName, formularyId: ctx.formularyId, tier: c.tier, cost: c.estMonthlyCost, plan: p.plan });
      }
    }
  }
  candidates.sort((a, b) => b.cost - a.cost || a.patientId.localeCompare(b.patientId) || a.rxcui.localeCompare(b.rxcui));

  const usedPatients = new Set<string>();
  const usedDrugs = new Set<string>();
  const applied: string[] = [];
  for (const c of candidates) {
    if (applied.length >= MAX_CHANGES) break;
    const key = `${c.formularyId}:${c.rxcui}`;
    if (usedPatients.has(c.patientId) || usedDrugs.has(key)) continue;

    // try each higher tier that every plan on the formulary can price, until one raises this patient's cost
    let newTier = await nextPricedTier(db, c.formularyId, c.tier);
    while (newTier !== null) {
      await db.run("UPDATE formulary SET tier = $1 WHERE data_version = $2 AND formulary_id = $3 AND rxcui = $4", [newTier, V2, c.formularyId, c.rxcui]);
      const after = (await coverageForRxcuis(db, await loadPlanContext(db, c.plan, V2), [c.rxcui])).get(c.rxcui)!;
      if ((after.estMonthlyCost ?? 0) > c.cost) {
        usedPatients.add(c.patientId);
        usedDrugs.add(key);
        applied.push(`${c.drugName}: tier ${c.tier} -> ${newTier} on formulary ${c.formularyId} (${c.patientName}'s plan ${c.plan.planName}: $${c.cost} -> $${after.estMonthlyCost}/mo)`);
        break;
      }
      await db.run("UPDATE formulary SET tier = $1 WHERE data_version = $2 AND formulary_id = $3 AND rxcui = $4", [c.tier, V2, c.formularyId, c.rxcui]);
      newTier = await nextPricedTier(db, c.formularyId, newTier);
    }
  }

  // 6. one change that hits several patients: the (formulary, drug) the most patients share
  const byDrug = new Map<string, typeof candidates>();
  for (const c of candidates) byDrug.set(`${c.formularyId}:${c.rxcui}`, [...(byDrug.get(`${c.formularyId}:${c.rxcui}`) ?? []), c]);
  const shared = [...byDrug.entries()].filter(([k]) => !usedDrugs.has(k)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const sharedRows = shared?.[1];
  if (sharedRows && sharedRows.length >= 2) {
    const c = sharedRows[0];
    const newTier = await nextPricedTier(db, c.formularyId, c.tier);
    if (newTier !== null) {
      await db.run("UPDATE formulary SET tier = $1 WHERE data_version = $2 AND formulary_id = $3 AND rxcui = $4", [newTier, V2, c.formularyId, c.rxcui]);
      applied.push(`${c.drugName}: tier ${c.tier} -> ${newTier} on formulary ${c.formularyId} (shared by ${sharedRows.length} patients: ${sharedRows.map((r) => r.patientId).join(", ")})`);
    }
  }

  await db.run("DELETE FROM data_versions WHERE data_version = $1", [V2]);
  await db.run("INSERT INTO data_versions (data_version, source, loaded_at) VALUES ($1, $2, CURRENT_TIMESTAMP)", [
    V2,
    `SYNTHETIC: copy of ${V1} with ${applied.length} formulary tier increases (scripts/make-v2.ts) - not CMS data`,
  ]);
  console.log(`\nv2 = v1 + ${applied.length} synthetic tier increases:`);
  for (const line of applied) console.log("  " + line);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
