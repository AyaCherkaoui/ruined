import type { Db } from "../db";
import type { CoverageChangeFact, CoverageChangeFactType, CoverageObservation } from "./aggregate-contract";
import { adverseTypes } from "./detectChanges";
import { observationKey, planKey, readRun, stableId } from "./aggregate-store";

const inverse: Partial<Record<CoverageChangeFactType, CoverageChangeFactType>> = {
  coverage_restored: "coverage_removed", tier_decreased: "tier_increased",
  prior_authorization_removed: "prior_authorization_added", step_therapy_removed: "step_therapy_added",
  quantity_limit_removed: "quantity_limit_added", quantity_limit_relaxed: "quantity_limit_tightened",
};

export function classifyObservations(a: CoverageObservation, b: CoverageObservation): CoverageChangeFactType[] {
  if (a.covered !== b.covered) return [b.covered ? "coverage_restored" : "coverage_removed"];
  if (!a.covered) return [];
  // Reuse the legacy adverse classifier with unknown values neutralized. Unknown tier is
  // not a removal here: explicit coverage, rather than a missing join, is authoritative.
  const known = (x: boolean | null, y: boolean | null) => x !== null && y !== null;
  const oldTier = a.tier !== null && b.tier !== null ? a.tier : 1;
  const newTier = a.tier !== null && b.tier !== null ? b.tier : 1;
  const mapped = adverseTypes({ formulary_id: "", rxcui: a.rxcui, old_tier: oldTier, new_tier: newTier,
    old_pa: known(a.priorAuthorization, b.priorAuthorization) ? a.priorAuthorization! : false,
    new_pa: known(a.priorAuthorization, b.priorAuthorization) ? b.priorAuthorization! : false,
    old_st: known(a.stepTherapy, b.stepTherapy) ? a.stepTherapy! : false,
    new_st: known(a.stepTherapy, b.stepTherapy) ? b.stepTherapy! : false,
    old_ql: known(a.quantityLimit.applies, b.quantityLimit.applies) ? a.quantityLimit.applies! : false,
    new_ql: known(a.quantityLimit.applies, b.quantityLimit.applies) ? b.quantityLimit.applies! : false,
  });
  const names = { removed: "coverage_removed", tier_increase: "tier_increased", new_prior_auth: "prior_authorization_added", new_step_therapy: "step_therapy_added", new_quantity_limit: "quantity_limit_added" } as const;
  const result: CoverageChangeFactType[] = mapped.map((t) => names[t]);
  if (newTier < oldTier) result.push("tier_decreased");
  if (a.priorAuthorization === true && b.priorAuthorization === false) result.push("prior_authorization_removed");
  if (a.stepTherapy === true && b.stepTherapy === false) result.push("step_therapy_removed");
  if (a.quantityLimit.applies === true && b.quantityLimit.applies === false) result.push("quantity_limit_removed");
  const x = a.quantityLimit, y = b.quantityLimit;
  if (x.applies && y.applies && x.amount !== null && x.days !== null && y.amount !== null && y.days !== null) {
    const delta = y.amount * x.days - x.amount * y.days;
    if (delta !== 0) result.push(delta < 0 ? "quantity_limit_tightened" : "quantity_limit_relaxed");
  }
  return result;
}

export async function readChanges(db: Db): Promise<CoverageChangeFact[]> {
  return (await db.query<{ payload: string }>("SELECT payload FROM coverage_change_facts ORDER BY id")).map((r) => JSON.parse(r.payload));
}

export async function compareSnapshots(db: Db, from: string, to: string): Promise<CoverageChangeFact[]> {
  const a = await readRun(db, from), b = await readRun(db, to);
  if (a.run.status !== "completed" || b.run.status !== "completed") throw new Error("Only completed runs can be compared");
  if (a.run.source !== b.run.source || Date.parse(a.run.capturedAt) >= Date.parse(b.run.capturedAt)) throw new Error("Runs must have the same source and increasing timestamps");
  if (JSON.stringify(a.observations.map(observationKey).sort()) !== JSON.stringify(b.observations.map(observationKey).sort())) throw new Error("Scope mismatch: missing rows never imply removal");
  const comparisons = await db.query<{ from_run: string; to_run: string }>("SELECT * FROM coverage_comparisons");
  const existing = comparisons.find((r) => r.to_run === to);
  if (existing && existing.from_run !== from) throw new Error("Target run already compared to another baseline");
  if (existing) return (await readChanges(db)).filter((c) => b.observations.some((o) => o.id === c.newObservationId) && a.observations.some((o) => o.id === c.oldObservationId));
  // A single chronological chain avoids resolving facts from a different branch or future run.
  if (comparisons.length && (!comparisons.some((r) => r.to_run === from) || comparisons.some((r) => r.from_run === from))) throw new Error("Comparison must extend the existing chain");
  const facts = await readChanges(db);
  const result: CoverageChangeFact[] = [];
  const previous = new Map(a.observations.map((o) => [observationKey(o), o]));
  await db.run("BEGIN TRANSACTION");
  try {
    for (const next of b.observations) {
      const old = previous.get(observationKey(next))!;
      for (const changeType of classifyObservations(old, next)) {
        const direction = inverse[changeType] ? "improved" : "worsened";
        const fact: CoverageChangeFact = { id: stableId(old.id, next.id, changeType), oldObservationId: old.id, newObservationId: next.id,
          plan: next.plan, rxcui: next.rxcui, direction, changeType, detectedAt: b.run.capturedAt, effectiveAt: next.effectiveAt,
          resolvesChangeId: null, resolvedByChangeId: null,
          provenance: old.provenance === "simulated" || next.provenance === "simulated" ? "simulated" : old.provenance === "replay" || next.provenance === "replay" ? "replay" : "live" };
        const reversed = facts.filter((f) => f.changeType === inverse[changeType] && f.resolvedByChangeId === null && f.rxcui === next.rxcui && planKey(f.plan) === planKey(next.plan))
          .sort((x, y) => y.detectedAt.localeCompare(x.detectedAt) || y.id.localeCompare(x.id))[0];
        if (direction === "improved" && reversed) {
          fact.resolvesChangeId = reversed.id;
          reversed.resolvedByChangeId = fact.id;
          await db.run("UPDATE coverage_change_facts SET payload=$1 WHERE id=$2", [JSON.stringify(reversed), reversed.id]);
        }
        await db.run("INSERT INTO coverage_change_facts VALUES ($1,$2,$3,$4)", [fact.id, from, to, JSON.stringify(fact)]);
        result.push(fact);
      }
    }
    await db.run("INSERT INTO coverage_comparisons VALUES ($1,$2)", [to, from]);
    await db.run("COMMIT");
  } catch (error) { await db.run("ROLLBACK"); throw error; }
  return result;
}
