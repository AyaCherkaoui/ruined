import type { Db } from "./db";
import { pickPrimaryClass, RxNavClient, type RxConcept } from "./rxnav";

// Drug normalizer: free-text drug name -> RXCUI (RxNav) -> drug class (RxClass, ATC level 4).
// Results are cached in the `drugs` / `drug_aliases` tables so the app works offline after warm-up.
// This is lookup + string matching only; coverage decisions never come from here.

export interface DrugRecord {
  rxcui: string;
  name: string;
  /** RxNorm term type: SCD = generic clinical drug, SBD = branded drug, IN = ingredient, BN = brand name... */
  tty: string | null;
  ingredientRxcui: string | null;
  ingredientName: string | null;
  classId: string | null;
  className: string | null;
  classType: string | null;
  doseFormGroup: string | null;
  /** For a branded drug (SBD): the generic clinical drug (SCD) it is a tradename of. */
  genericRxcui: string | null;
}

let defaultClient: RxNavClient | undefined;
function client(): RxNavClient {
  return (defaultClient ??= new RxNavClient());
}

/** Lowercase, collapse whitespace, strip punctuation that RxNav ignores anyway. */
export function normalizeAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9./%\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Which RxNorm concept types we prefer when a match returns several: the formulary is keyed
// by SCD/SBD (a specific strength + dose form), so those beat components, ingredients and brand names.
const TTY_PRIORITY: Record<string, number> = {
  SCD: 0,
  SBD: 0,
  GPCK: 1,
  BPCK: 1,
  SCDG: 2,
  SBDG: 2,
  SCDF: 2,
  SBDF: 2,
  SCDC: 3,
  SBDC: 3,
  IN: 4,
  MIN: 4,
  PIN: 4,
  BN: 5,
};
const priorityOf = (tty: string) => TTY_PRIORITY[tty] ?? 6;
// Partial concepts ("lisinopril 10 MG" = ingredient + strength, no dose form). RxNav matches these
// exactly, but they never appear in a formulary, so we try to upgrade them to a full SCD/SBD.
const PARTIAL_TTYS = new Set(["SCDC", "SBDC", "SCDF", "SBDF", "SCDG", "SBDG"]);

/**
 * Name -> best RXCUI, or null. Exact/normalized match first, RxNav approximate match second.
 * A bare ingredient or brand name ("Ozempic", "insulin glargine") resolves to that IN/BN concept as-is:
 * without a strength there is no single right clinical drug, so callers expand it against a plan formulary.
 */
export async function resolveRxcui(name: string, rx: RxNavClient = client()): Promise<string | null> {
  const exact = await rx.findRxcuiByName(name);
  let exactBest: { rxcui: string; priority: number } | null = null;
  if (exact.length > 0) {
    const concept = await rx.getConcept(exact[0]);
    if (concept && !PARTIAL_TTYS.has(concept.tty)) return exact[0];
    exactBest = { rxcui: exact[0], priority: concept ? priorityOf(concept.tty) : 6 };
  }

  const candidates = await rx.approximateTerm(name, 10);
  const top = candidates[0]?.score ?? 0;
  const shortlist = candidates.filter((c) => c.score >= top * 0.9).slice(0, 6);

  const scored: { rxcui: string; score: number; priority: number }[] = [];
  for (const c of shortlist) {
    const concept = await rx.getConcept(c.rxcui);
    if (!concept) continue;
    scored.push({ rxcui: c.rxcui, score: c.score, priority: priorityOf(concept.tty) });
  }
  scored.sort((a, b) => a.priority - b.priority || b.score - a.score);
  const best = scored[0];
  if (best && (!exactBest || best.priority < exactBest.priority)) return best.rxcui;
  return exactBest?.rxcui ?? null;
}

/** Fetch everything we store about an RXCUI from RxNav + RxClass (network). */
export async function fetchDrugRecord(rxcui: string, rx: RxNavClient = client()): Promise<DrugRecord | null> {
  const concept = await rx.getConcept(rxcui);
  if (!concept) return null;
  const related = await rx.getRelated(rxcui);

  let ingredients: RxConcept[] = related.ingredients;
  if (ingredients.length === 0 && (concept.tty === "IN" || concept.tty === "PIN")) ingredients = [concept];
  const combo: RxConcept | undefined = concept.tty === "MIN" ? concept : related.multiIngredient[0];
  const ingredient: RxConcept | null = ingredients.length === 1 ? ingredients[0] : ingredients.length > 1 ? combo ?? null : null;

  const cls = pickPrimaryClass(await rx.getAtcClasses(rxcui), ingredients);
  const productGroups = related.doseFormGroups.filter((n) => / Product$/.test(n)).sort();

  return {
    rxcui: concept.rxcui,
    name: concept.name,
    tty: concept.tty,
    ingredientRxcui: ingredient?.rxcui ?? null,
    ingredientName: ingredient?.name ?? null,
    classId: cls?.classId ?? null,
    className: cls?.className ?? null,
    classType: cls?.classType ?? null,
    doseFormGroup: productGroups[0] ?? null,
    genericRxcui: concept.tty === "SBD" ? related.genericDrugs[0]?.rxcui ?? null : null,
  };
}

interface DrugRow {
  rxcui: string;
  name: string;
  tty: string | null;
  ingredient_rxcui: string | null;
  ingredient_name: string | null;
  class_id: string | null;
  class_name: string | null;
  class_type: string | null;
  dose_form_group: string | null;
  generic_rxcui: string | null;
}

function fromRow(r: DrugRow): DrugRecord {
  return {
    rxcui: r.rxcui,
    name: r.name,
    tty: r.tty,
    ingredientRxcui: r.ingredient_rxcui,
    ingredientName: r.ingredient_name,
    classId: r.class_id,
    className: r.class_name,
    classType: r.class_type,
    doseFormGroup: r.dose_form_group,
    genericRxcui: r.generic_rxcui,
  };
}

export async function getCachedDrug(db: Db, rxcui: string): Promise<DrugRecord | null> {
  const rows = await db.query<DrugRow>("SELECT * FROM drugs WHERE rxcui = $1", [rxcui]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function saveDrug(db: Db, d: DrugRecord): Promise<void> {
  // delete + insert (not upsert): plain SQL that behaves the same on DuckDB and Postgres
  await db.run("DELETE FROM drugs WHERE rxcui = $1", [d.rxcui]);
  await db.run(
    `INSERT INTO drugs (rxcui, name, tty, ingredient_rxcui, ingredient_name, class_id, class_name,
                        class_type, dose_form_group, generic_rxcui, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
    [d.rxcui, d.name, d.tty, d.ingredientRxcui, d.ingredientName, d.classId, d.className, d.classType, d.doseFormGroup, d.genericRxcui],
  );
}

/** Cache-first lookup by RXCUI. Falls back to RxNav on a miss and caches the result. */
export async function getDrug(db: Db, rxcui: string, rx: RxNavClient = client()): Promise<DrugRecord | null> {
  const cached = await getCachedDrug(db, rxcui);
  if (cached) return cached;
  const fetched = await fetchDrugRecord(rxcui, rx);
  if (fetched) await saveDrug(db, fetched);
  return fetched;
}

/**
 * Normalize a drug name typed by a person ("Lipitor 40mg", "atorvastatin 40 mg tablet")
 * to a cached DrugRecord with its RXCUI and class. Returns null if RxNav cannot match it.
 */
export async function normalizeDrug(db: Db, name: string, rx: RxNavClient = client()): Promise<DrugRecord | null> {
  const alias = normalizeAlias(name);
  if (!alias) return null;

  const hit = await db.query<{ rxcui: string }>("SELECT rxcui FROM drug_aliases WHERE alias = $1", [alias]);
  if (hit[0]) {
    const cached = await getDrug(db, hit[0].rxcui, rx);
    if (cached) return cached;
  }

  const rxcui = await resolveRxcui(alias, rx);
  if (!rxcui) return null;
  const drug = await getDrug(db, rxcui, rx);
  if (drug) {
    await db.run("DELETE FROM drug_aliases WHERE alias = $1", [alias]);
    await db.run("INSERT INTO drug_aliases (alias, rxcui) VALUES ($1, $2)", [alias, drug.rxcui]);
  }
  return drug;
}
