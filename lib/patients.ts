import type { Patient } from "./contract";
import { DEFAULT_DATA_VERSION } from "./coverage";
import { getDb, type Db } from "./db";

// Read side for the synthetic patient roster. Plan names come from the plans table (real CMS data).

interface PatientRow {
  id: string;
  name: string;
  age: number;
  language: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
}

interface MedRow {
  patient_id: string;
  rxcui: string;
  drug_name: string;
  dose: string;
}

interface LoadFilter {
  id?: string;
  /** Case-insensitive substring match on name. */
  nameQuery?: string;
  limit?: number;
}

const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");

async function load(db: Db, filter: LoadFilter = {}): Promise<Patient[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [DEFAULT_DATA_VERSION];
  if (filter.id !== undefined) {
    params.push(filter.id);
    clauses.push(`p.id = $${params.length}`);
  }
  if (filter.nameQuery !== undefined) {
    params.push(`%${filter.nameQuery}%`);
    clauses.push(`p.name ILIKE $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limitSql = filter.limit !== undefined ? `LIMIT ${Math.max(0, Math.trunc(filter.limit))}` : "";

  const patients = await db.query<PatientRow>(
    `SELECT p.id, p.name, p.age, p.language, p.contract_id, p.plan_id, p.segment_id, pl.plan_name
       FROM patients p
       JOIN plans pl ON pl.data_version = $1 AND pl.contract_id = p.contract_id
                    AND pl.plan_id = p.plan_id AND pl.segment_id = p.segment_id
       ${where}
      ORDER BY p.id
      ${limitSql}`,
    params,
  );
  if (patients.length === 0) return [];

  const ids = patients.map((p) => p.id);
  const meds = await db.query<MedRow>(
    `SELECT patient_id, rxcui, drug_name, dose FROM patient_meds WHERE patient_id IN (${placeholders(ids.length)})
      ORDER BY patient_id, drug_name`,
    ids,
  );
  const byPatient = new Map<string, MedRow[]>();
  for (const m of meds) byPatient.set(m.patient_id, [...(byPatient.get(m.patient_id) ?? []), m]);

  return patients.map((p) => ({
    id: p.id,
    name: p.name,
    age: p.age,
    language: p.language,
    plan: { contractId: p.contract_id, planId: p.plan_id, segmentId: p.segment_id, planName: p.plan_name },
    meds: (byPatient.get(p.id) ?? []).map((m) => ({ rxcui: m.rxcui, drugName: m.drug_name, dose: m.dose })),
  }));
}

export async function listPatients(db?: Db): Promise<Patient[]> {
  return load(db ?? (await getDb()));
}

export async function getPatient(id: string, db?: Db): Promise<Patient | null> {
  return (await load(db ?? (await getDb()), { id }))[0] ?? null;
}

export const MAX_PATIENT_SEARCH = 8;

/** Case-insensitive substring match on patient name, capped at `limit` (default 8). */
export async function searchPatients(query: string, limit = MAX_PATIENT_SEARCH, db?: Db): Promise<Patient[]> {
  const q = query.trim();
  if (!q) return [];
  return load(db ?? (await getDb()), { nameQuery: q, limit });
}
