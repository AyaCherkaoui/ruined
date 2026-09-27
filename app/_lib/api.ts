import { displayDrugName } from "../../components/format";
import type { CheckResponse, CoverageAlert, DrugOption, PatientAlert, PatientSummary } from "@/lib/contract";

export interface DrugHit extends DrugOption {
  displayName: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // The body was not JSON; the status line is enough.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function searchPatients(q: string): Promise<PatientSummary[]> {
  return getJson<PatientSummary[]>(`/api/patients/search?${new URLSearchParams({ q })}`);
}

export async function searchDrugs(patientId: string, q: string): Promise<DrugHit[]> {
  const rows = await getJson<DrugOption[]>(`/api/drugs/search?${new URLSearchParams({ patientId, q })}`);
  return rows.map((drug) => ({ ...drug, displayName: displayDrugName(drug.drugName) }));
}

export async function checkDrug(patientId: string, rxcui: string): Promise<CheckResponse> {
  return getJson<CheckResponse>("/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId, rxcui }),
  });
}

export async function dismissAlert(id: string): Promise<PatientAlert> {
  return getJson<PatientAlert>(`/api/alerts/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
}

export async function resetDemo(): Promise<{ reset: true }> {
  return getJson<{ reset: true }>("/api/demo/reset", { method: "POST" });
}

export async function resolveCoverageAlert(id: string): Promise<CoverageAlert> {
  return getJson<CoverageAlert>(`/api/alerts/${encodeURIComponent(id)}/resolve`, { method: "POST" });
}
