import Link from "next/link";
import { ChevronRight, TriangleAlert } from "lucide-react";
import type { CoverageAlert, DashboardResponse } from "@/lib/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CostChart, type CostPoint } from "@/components/cost-chart";
import { alertSentence, chartLabel, displayDrugName, estMoney, STATUS_STYLE } from "@/components/format";

export function Dashboard({
  dashboard,
  alerts,
}: {
  dashboard: DashboardResponse;
  alerts: CoverageAlert[];
}) {
  const names = dashboard.atRisk.map((row) => row.patient.name);
  const points: CostPoint[] = dashboard.atRisk.map((row) => ({
    name: chartLabel(row.patient.name, names),
    patient: row.patient.name,
    drug: displayDrugName(row.worstDrug.drugName),
    current: row.worstDrug.estMonthlyCost,
    alternative: row.bestAlternative?.estMonthlyCost ?? null,
    alternativeName: row.bestAlternative ? displayDrugName(row.bestAlternative.drugName) : null,
  }));

  return (
    <div className="min-h-full bg-white">
      <div className="h-1.5 bg-teal-700" />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-8">
          <div>
            <p className="text-sm font-medium tracking-wide text-teal-800">Medicare Part D</p>
            <h1 className="mt-3 max-w-[14ch] text-4xl font-semibold leading-[1.05] tracking-tight text-balance text-neutral-950 sm:text-6xl">
              How many patients have I financially ruined?
            </h1>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-l-4 border-l-red-600">
              <CardContent className="flex flex-col gap-1">
                <p className="text-7xl font-semibold tabular-nums tracking-tight text-red-700 sm:text-8xl">
                  {dashboard.patientsOverpaying}
                </p>
                <p className="text-lg text-neutral-800">
                  of {dashboard.totalPatients} patients
                </p>
                <CardDescription className="text-base">at risk of overpaying</CardDescription>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-emerald-600">
              <CardContent className="flex flex-col gap-1">
                <p className="text-4xl font-semibold tabular-nums tracking-tight text-emerald-800 sm:text-5xl">
                  {estMoney(dashboard.totalPotentialMonthlySavings)}
                </p>
                <p className="text-lg text-neutral-800">potential monthly savings</p>
                <CardDescription className="text-base">
                  from the cheaper covered alternatives on this list
                </CardDescription>
              </CardContent>
            </Card>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-neutral-600">
            Every dollar amount is an estimate for a typical 30-day fill. Deductibles and coverage
            phases are not included.
          </p>
        </header>

        <section className="flex flex-col gap-3" aria-labelledby="alerts-heading">
          <h2 id="alerts-heading" className="text-2xl font-semibold tracking-tight text-neutral-950">
            Coverage changes
          </h2>
          {alerts.length === 0 ? (
            <Card>
              <CardContent className="text-base text-neutral-700">No coverage changes.</CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {alerts.map((alert) => (
                <li key={`${alert.patientId}-${alert.drugName}`}>
                  <Link
                    href={`/patients/${alert.patientId}`}
                    className="block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-amber-700"
                  >
                    <Alert className="min-h-14 border-amber-300 bg-amber-50 px-4 py-4 text-base text-neutral-950">
                      <TriangleAlert className="text-amber-700" aria-hidden />
                      <AlertTitle className="text-base leading-snug font-medium">
                        {alertSentence(alert)}
                      </AlertTitle>
                      <AlertDescription className="text-sm text-amber-950/80">
                        Tier {alert.oldTier} to tier {alert.newTier}
                      </AlertDescription>
                    </Alert>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="patients-heading">
          <h2 id="patients-heading" className="text-2xl font-semibold tracking-tight text-neutral-950">
            Patients at risk
          </h2>
          {dashboard.atRisk.length === 0 ? (
            <Card>
              <CardContent className="text-base text-emerald-800">
                No patients are flagged right now.
              </CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {dashboard.atRisk.map((row) => {
                const status = STATUS_STYLE[row.worstDrug.status];
                const alternative = row.bestAlternative;
                return (
                  <li key={row.patient.id}>
                    <Link
                      href={`/patients/${row.patient.id}`}
                      className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-teal-700"
                    >
                      <Card
                        className={`min-h-16 border-l-4 transition-colors hover:bg-neutral-50 active:bg-neutral-100 ${status.rule}`}
                      >
                        <CardContent className="grid gap-4 sm:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,1.15fr)] sm:items-center">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-lg font-semibold text-neutral-950">
                                {row.patient.name}
                              </p>
                              <p className="mt-0.5 text-base text-neutral-600">
                                {row.patient.age} · {row.patient.language}
                              </p>
                            </div>
                            <ChevronRight className="mt-1 size-5 shrink-0 text-neutral-400 sm:hidden" aria-hidden />
                          </div>
                          <div>
                            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                              Worst drug
                            </p>
                            <p className="mt-1 text-base font-medium text-neutral-950">
                              {displayDrugName(row.worstDrug.drugName)}
                            </p>
                            <p className="mt-0.5 text-base font-semibold text-red-700 tabular-nums">
                              {estMoney(row.worstDrug.estMonthlyCost)}/mo
                            </p>
                            <Badge className={`mt-2 h-7 px-2.5 text-sm ${status.badge}`}>
                              {status.label}
                            </Badge>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                                Best alternative
                              </p>
                              {alternative ? (
                                <>
                                  <p className="mt-1 text-base font-medium text-neutral-950">
                                    {displayDrugName(alternative.drugName)}
                                  </p>
                                  <p className="mt-0.5 text-base font-semibold text-emerald-800 tabular-nums">
                                    saves {estMoney(alternative.monthlySavings)}/mo
                                  </p>
                                  {alternative.status !== "covered" ? (
                                    <Badge
                                      className={`mt-2 h-7 px-2.5 text-sm ${STATUS_STYLE[alternative.status].badge}`}
                                    >
                                      {STATUS_STYLE[alternative.status].label}
                                    </Badge>
                                  ) : null}
                                </>
                              ) : (
                                <p className="mt-1 text-base font-semibold text-red-700">
                                  No safe cheaper option
                                </p>
                              )}
                            </div>
                            <ChevronRight
                              className="mt-1 hidden size-5 shrink-0 text-neutral-400 sm:block"
                              aria-hidden
                            />
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="chart-heading">
          <Card>
            <CardHeader>
              <CardTitle id="chart-heading" className="text-2xl font-semibold tracking-tight">
                Current cost vs alternative
              </CardTitle>
              <CardDescription className="text-base text-neutral-600">
                Red is what they pay now. Green is the cheaper covered option. A missing green bar
                means no safe cheaper option. Amounts are est. $ / month.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {points.length === 0 ? (
                <p className="text-base text-neutral-700">Nothing to compare.</p>
              ) : (
                <>
                  <CostChart points={points} />
                  <div className="sr-only">
                    <table>
                      <caption>Estimated monthly cost versus alternative cost by patient</caption>
                      <thead>
                        <tr>
                          <th>Patient</th>
                          <th>Current drug</th>
                          <th>Current cost</th>
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
