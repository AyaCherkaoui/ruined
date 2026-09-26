#!/usr/bin/env -S npx tsx
/**
 * Seeds the one-drug demo scenario: 1 doctor, 5 patients (full names only) all prescribed
 * NovoLog FlexPen (rxcui 1653204, insulin aspart -- see PROGRESS.md task 1) -- 3 on a real plan
 * where it lost coverage between v1 and v2-cms, 2 on a real plan where it's still covered.
 * Idempotent: rerunning does not create duplicate rows or patients.
 *
 *   npx tsx scripts/seed-scenario.ts
 */
import { openDb, type Db } from "../lib/db";

export const CHOSEN_RXCUI = "1653204"; // NovoLog FlexPen, insulin aspart

// Real Georgia plans (see PROGRESS.md task 1 for the checkCoverage evidence at each version).
export const LOST_COVERAGE_PLAN = { contractId: "H1170", planId: "002", segmentId: "000" }; // Kaiser Permanente Senior Advantage Enhanced 1 (HMO)
export const KEPT_COVERAGE_PLAN = { contractId: "S5884", planId: "135", segmentId: "000" }; // Humana Basic Rx Plan (PDP)

export const DOCTOR = { id: "doc-001", fullName: "Dr. Maria Alvarez", phone: "404-555-0142" };

export const PATIENTS: { id: string; fullName: string; plan: typeof LOST_COVERAGE_PLAN }[] = [
  { id: "pt-001", fullName: "Diane Whitfield", plan: LOST_COVERAGE_PLAN },
  { id: "pt-002", fullName: "Marcus Reyes", plan: LOST_COVERAGE_PLAN },
  { id: "pt-003", fullName: "Sandra Nguyen", plan: LOST_COVERAGE_PLAN },
  { id: "pt-004", fullName: "Harold Betancourt", plan: KEPT_COVERAGE_PLAN },
  { id: "pt-005", fullName: "Rosa Lindqvist", plan: KEPT_COVERAGE_PLAN },
];

// Before either loaded release, so both v1 and v2-cms coverage are real, in-force facts for them.
export const STARTED_AT = "2026-05-01";

async function ensureDoctor(db: Db): Promise<void> {
  const existing = await db.query<{ id: string }>("SELECT id FROM doctors WHERE id = $1", [DOCTOR.id]);
  if (existing.length > 0) return;
  await db.run("INSERT INTO doctors (id, full_name, phone) VALUES ($1, $2, $3)", [DOCTOR.id, DOCTOR.fullName, DOCTOR.phone]);
}

async function ensurePatient(db: Db, p: (typeof PATIENTS)[number]): Promise<void> {
  const existing = await db.query<{ id: string }>("SELECT id FROM patients WHERE id = $1", [p.id]);
  if (existing.length === 0) {
    await db.run("INSERT INTO patients (id, full_name) VALUES ($1, $2)", [p.id, p.fullName]);
  }
  const coverage = await db.query<{ patient_id: string }>("SELECT patient_id FROM patient_coverage WHERE patient_id = $1", [p.id]);
  if (coverage.length === 0) {
    await db.run("INSERT INTO patient_coverage (patient_id, contract_id, plan_id, segment_id) VALUES ($1, $2, $3, $4)", [
      p.id,
      p.plan.contractId,
      p.plan.planId,
      p.plan.segmentId,
    ]);
  }
}

async function ensurePrescription(db: Db, id: string, patientId: string, rxcui: string): Promise<void> {
  const existing = await db.query<{ id: string }>("SELECT id FROM prescriptions WHERE id = $1", [id]);
  if (existing.length > 0) return;
  await db.run("INSERT INTO prescriptions (id, patient_id, doctor_id, rxcui, started_at) VALUES ($1, $2, $3, $4, $5)", [
    id,
    patientId,
    DOCTOR.id,
    rxcui,
    STARTED_AT,
  ]);
}

export function prescriptionId(patientId: string): string {
  return `rx-${patientId.replace("pt-", "")}`;
}

export async function seedScenario(db: Db): Promise<void> {
  await ensureDoctor(db);
  for (const p of PATIENTS) {
    await ensurePatient(db, p);
    await ensurePrescription(db, prescriptionId(p.id), p.id, CHOSEN_RXCUI);
  }
}

async function main() {
  const db = await openDb();
  await seedScenario(db);
  const patients = await db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM patients ORDER BY id");
  const rx = await db.query<{ id: string; patient_id: string; rxcui: string }>("SELECT id, patient_id, rxcui FROM prescriptions ORDER BY id");
  console.log(`doctor: ${DOCTOR.id} ${DOCTOR.fullName}`);
  console.log(`patients (${patients.length}):`, patients);
  console.log(`prescriptions (${rx.length}):`, rx);
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
