import { headers } from "next/headers";
import type { CoverageAlert, DashboardResponse } from "@/lib/contract";
import { Dashboard } from "@/components/dashboard";

async function getJson<T>(path: string): Promise<T> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  if (!host) throw new Error("Missing request host");

  const response = await fetch(`${proto}://${host}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export default async function Home() {
  const [dashboard, alerts] = await Promise.all([
    getJson<DashboardResponse>("/api/dashboard"),
    getJson<CoverageAlert[]>("/api/alerts"),
  ]);

  return <Dashboard dashboard={dashboard} alerts={alerts} />;
}
