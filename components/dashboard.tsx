import type { PatientAlert } from "@/lib/contract";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CostChart, type CostPoint } from "@/components/cost-chart";
import { chartLabel, coverageChangeSentence, displayDrugName, estMoney } from "@/components/format";

function isOpen(alert: PatientAlert): boolean {
  return alert.status === "new" || alert.status === "seen";
}

function potentialSavings(alerts: PatientAlert[]): number | null {
  let cents = 0;
  let any = false;
  for (const alert of alerts) {
    const base = alert.newMonthlyCost ?? alert.oldMonthlyCost;
    if (base == null || alert.bestAlternativeCost == null) continue;
    const saved = Math.round((base - alert.bestAlternativeCost) * 100);
    if (saved <= 0) continue;
    any = true;
    cents += saved;
  }
  return any ? cents / 100 : null;
}

export function Dashboard({ alerts, totalPatients }: { alerts: PatientAlert[]; totalPatients: number }) {
  const open = alerts.filter(isOpen);
  const affected = new Set(open.map((alert) => alert.patientId)).size;
  const savings = potentialSavings(open);
  const names = open.map((alert) => alert.patientName);
  const points: CostPoint[] = open.map((alert) => ({
    name: chartLabel(alert.patientName, names),
    patient: alert.patientName,
    drug: displayDrugName(alert.drugName),
    current: alert.oldMonthlyCost,
    alternative: alert.bestAlternativeCost,
    alternativeName: alert.bestAlternativeName ? displayDrugName(alert.bestAlternativeName) : null,
  }));

  return (
    <div className="min-h-full bg-white">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-8">
          <h1 className="max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-6xl">
            HeadsUp coverage impact
          </h1>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-l-4 border-l-red-600">
              <CardContent className="flex flex-col gap-1">
                <p className="text-7xl font-semibold tabular-nums tracking-tight text-red-700 sm:text-8xl">{affected}</p>
                <p className="text-lg text-neutral-800">of {totalPatients} patients</p>
                <CardDescription className="text-base">affected by a coverage change</CardDescription>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-emerald-600">
              <CardContent className="flex flex-col gap-1">
                <p className="text-4xl font-semibold tabular-nums tracking-tight text-emerald-800 sm:text-5xl">
                  {estMoney(savings)}
                </p>
                <p className="text-lg text-neutral-800">potential monthly savings</p>
                <CardDescription className="text-base">
                  {savings == null
                    ? "No cheaper covered alternative on these alerts"
                    : "from the cheaper covered alternatives on this list"}
                </CardDescription>
              </CardContent>
            </Card>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-neutral-600">
            Every dollar amount is an estimate for a typical 30-day fill. Deductibles and coverage phases are not included.
          </p>
        </header>

        <section className="flex flex-col gap-3" aria-labelledby="alerts-heading">
          <h2 id="alerts-heading" className="text-2xl font-semibold tracking-tight text-neutral-950">
            Coverage changes
          </h2>
          {open.length === 0 ? (
            <Card>
              <CardContent className="text-base text-neutral-700">No coverage changes.</CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {open.map((alert) => (
                <li key={alert.id}>
                  <Card>
                    <CardContent className="flex flex-col gap-2">
                      <p className="text-base font-medium text-neutral-950">{coverageChangeSentence(alert)}</p>
                      <p className="text-sm text-neutral-600">
                        {alert.patientName} · {alert.planName}
                      </p>
                      {alert.bestAlternativeName ? (
                        <Badge className="h-7 w-fit px-2.5 text-sm border-emerald-200 bg-emerald-50 text-emerald-800">
                          {displayDrugName(alert.bestAlternativeName)} · {estMoney(alert.bestAlternativeCost)}/mo
                        </Badge>
                      ) : (
                        <p className="text-sm font-medium text-red-700">No safe cheaper option</p>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="chart-heading">
          <Card>
            <CardHeader>
              <CardTitle id="chart-heading" className="text-2xl font-semibold tracking-tight">
                Cost before the change vs alternative
              </CardTitle>
              <CardDescription className="text-base text-neutral-600">
                Red is the estimated cost before the change. Green is a cheaper covered alternative. A missing green bar
                means no safe cheaper option. Amounts are est. $ / month.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {points.length === 0 ? (
                <p className="text-base text-neutral-700">Nothing to compare.</p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-neutral-600">Showing the first {Math.min(20, points.length)} of {points.length} prescription alerts. Review the full list on the patient dashboard.</p>
                  <CostChart points={points.slice(0, 20)} />
                  <div className="sr-only">
                    <table>
                      <caption>Estimated monthly cost before the change versus alternative cost by patient</caption>
                      <thead>
                        <tr>
                          <th>Patient</th>
                          <th>Drug</th>
                          <th>Cost before</th>
                          <th>Alternative</th>
                          <th>Alternative cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {points.map((point) => (
                          <tr key={point.patient}>
                            <td>{point.patient}</td>
                            <td>{point.drug}</td>
                            <td>{estMoney(point.current)} per month</td>
                            <td>{point.alternativeName ?? "No safe cheaper option"}</td>
                            <td>
                              {point.alternativeName
                                ? `${estMoney(point.alternative)} per month`
                                : "No safe cheaper option"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
