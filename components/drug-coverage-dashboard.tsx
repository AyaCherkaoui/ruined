import { PolicyDemo } from "./policy-demo";
import { estMoney } from "./format";
import type { DrugGroup, DrugPlanRow, Range, Restrictions } from "../lib/drug-coverage-view";
import { policyChangeLabel } from "../lib/medishift-view";

function tierLabel(tiers: Range, covered = true): string {
  if (!covered) return "Not covered";
  if (!tiers) return "—";
  return tiers[0] === tiers[1] ? `Tier ${tiers[0]}` : `Tier ${tiers[0]}–${tiers[1]}`;
}

function costLabel(costs: Range): string {
  if (!costs) return estMoney(null);
  return costs[0] === costs[1] ? estMoney(costs[0]) : `${estMoney(costs[0])}–${estMoney(costs[1]).replace("est. ", "")}`;
}

const RESTRICTIONS: { key: keyof Restrictions; label: string; short: string }[] = [
  { key: "priorAuth", label: "Prior authorization", short: "PA" },
  { key: "stepTherapy", label: "Step therapy", short: "ST" },
  { key: "quantityLimit", label: "Quantity limit", short: "QL" },
];

function RestrictionChips({ now, before }: { now: Restrictions; before?: Restrictions }) {
  const active = RESTRICTIONS.filter((r) => now[r.key]);
  if (!active.length) return <span className="text-[#6d6788]">None</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {active.map((r) => {
        const added = before ? !before[r.key] : false;
        return (
          <span
            key={r.key}
            title={r.label}
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${added ? "bg-amber-100 text-amber-900 ring-1 ring-amber-300" : "bg-[#f0edfb] text-[#4b3fd4]"}`}
          >
            {r.label}
            {added ? " · new" : ""}
          </span>
        );
      })}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-h-28 flex-col justify-between rounded-3xl bg-white px-5 py-4 shadow-sm ring-1 ring-[#e6e1f2]">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-[#6d6788]">{label.toUpperCase()}</p>
      <p className="text-4xl font-semibold tabular-nums text-[#1b1733]">{value}</p>
    </div>
  );
}

function PlanRow({ row }: { row: DrugPlanRow }) {
  const nowCovered = row.now.status !== "not_covered";
  return (
    <li className="rounded-2xl border border-[#e6e1f2] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[#1b1733]">{row.planName}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#8a84a3]">
            {row.strengths.map((s) => (
              <span key={s} className="rounded-full bg-[#f0edfb] px-2 py-0.5 font-semibold text-[#4b3fd4]">{s.toLowerCase()}</span>
            ))}
            <span title={row.drugNames.join(" · ")}>{row.planIds.join(", ")}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {row.changeTypes.map((type) => (
            <span
              key={type}
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${type === "removed" ? "bg-red-50 text-red-800 ring-1 ring-red-200" : "bg-amber-50 text-amber-950 ring-1 ring-amber-300"}`}
            >
              {policyChangeLabel(type)}
            </span>
          ))}
        </div>
      </div>

      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold text-[#6d6788]">Tier</dt>
          <dd className="mt-1 text-[#1b1733]">
            {tierLabel(row.before.tiers)} → <span className={nowCovered ? "" : "font-semibold text-red-700"}>{tierLabel(row.now.tiers, nowCovered)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-[#6d6788]">Restrictions now</dt>
          <dd className="mt-1">{nowCovered ? <RestrictionChips now={row.now} before={row.before} /> : <span className="text-[#6d6788]">—</span>}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-[#6d6788]">Monthly cost</dt>
          <dd className="mt-1 text-[#1b1733]">
            {costLabel(row.before.costs)} → {nowCovered ? costLabel(row.now.costs) : <span className="font-semibold text-red-700">not covered</span>}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-[#6d6788]">
        {row.affectedPatients} {row.affectedPatients === 1 ? "patient" : "patients"} in your practice affected
      </p>

      <div className="mt-4 border-t border-[#f0edfb] pt-3">
        <p className="text-xs font-semibold text-[#6d6788]">Covered alternatives on this plan</p>
        {row.alternatives.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {row.alternatives.map((alt) => (
              <li key={alt.name} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-[#1b1733]">
                  {alt.name}
                  {alt.strengths.length ? <span className="ml-1.5 text-xs font-normal text-[#8a84a3]">{alt.strengths.map((s) => s.toLowerCase()).join(" · ")}</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-[#3c3658]">
                  <span>{alt.tier == null ? "—" : `Tier ${alt.tier}`}</span>
                  <RestrictionChips now={alt.restrictions} />
                  <span className="tabular-nums">{estMoney(alt.estMonthlyCost)}/mo</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-[#6d6788]">No covered alternative returned for this plan.</p>
        )}
      </div>
    </li>
  );
}

export function DrugCoverageDashboard({ groups, affectedPatients }: { groups: DrugGroup[]; affectedPatients: number }) {
  const rows = groups.flatMap((g) => g.plans);
  const plans = new Set(rows.flatMap((r) => r.planIds)).size;
  const changes = rows.reduce((n, r) => n + r.changeTypes.length, 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <PolicyDemo />

      <section className="rounded-[28px] bg-[#5c4dff] px-6 py-7 text-white shadow-sm sm:px-8 sm:py-8">
        <p className="inline-flex rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold tracking-[0.14em]">FORMULARY CHANGES · CMS PART D</p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
          {groups.length} {groups.length === 1 ? "drug" : "drugs"} changed on {plans} {plans === 1 ? "plan" : "plans"}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-white/90">
          Tiers, restrictions, and estimated monthly costs before and after each insurer change, with covered alternatives on the same plan.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Drugs" value={groups.length} />
        <Stat label="Insurance plans" value={plans} />
        <Stat label="Coverage changes" value={changes} />
        <Stat label="Patients affected" value={affectedPatients} />
      </section>

      {groups.length === 0 ? (
        <p className="rounded-3xl bg-white px-6 py-10 text-[#3c3658] shadow-sm ring-1 ring-[#e6e1f2]">No drugs are affected by the current policy update.</p>
      ) : (
        groups.map((group) => (
          <section key={group.drugName} className="flex flex-col gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-[#1b1733]">{group.drugName}</h2>
              <p className="text-sm text-[#6d6788]">{[...new Set(group.plans.flatMap((p) => p.drugNames))].join(" · ")}</p>
            </div>
            <ul className="flex flex-col gap-3">
              {group.plans.map((row) => (
                <PlanRow key={row.key} row={row} />
              ))}
            </ul>
          </section>
        ))
      )}

      <p className="text-xs text-[#6d6788]">
        Every cost is an estimate for a typical 30-day fill from CMS formulary and pricing files. Patient counts are aggregates; no patient details are shown.
      </p>
    </main>
  );
}
