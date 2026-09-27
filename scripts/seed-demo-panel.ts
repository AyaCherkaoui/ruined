#!/usr/bin/env -S npx tsx
/**
 * Demo panel for the doctor workflow. Uses coverage changes that already exist in the
 * loaded CMS files (v1 → v2-cms). It does not invent formulary removals.
 *
 * NovoLog stays in the database, but those prescriptions move off doc-001. Insulin is
 * outside the interchangeable-class list, so it cannot show formulary alternatives.
 *
 *   npx tsx scripts/seed-demo-panel.ts
 */
import { findAlternatives } from "../lib/alternatives";
import { openDb, type Db } from "../lib/db";
import { matchPrescriptions } from "../lib/pipeline/matchPrescriptions";
import type { PatientAlertStatus } from "../lib/contract";
import { DEMO_DOCTOR_ID } from "../lib/scenario";

const ARCHIVE_DOCTOR = { id: "doc-archive", fullName: "Archived NovoLog scenario" };
const NOVOLOG = "1653204";
const STARTED_AT = "2026-05-01";

type Plan = { contractId: string; planId: string; segmentId: string };

export const DEMO_PANEL: {
  id: string;
  fullName: string;
  rxcui: string;
  plan: Plan;
  status: PatientAlertStatus;
}[] = [
  { id: "pt-101", fullName: "Ava Rahman", rxcui: "1486977", plan: { contractId: "H0111", planId: "001", segmentId: "000" }, status: "new" },
  { id: "pt-102", fullName: "Benito Alvarez", rxcui: "1486977", plan: { contractId: "H1112", planId: "038", segmentId: "000" }, status: "seen" },
  { id: "pt-103", fullName: "Camille Brooks", rxcui: "1486981", plan: { contractId: "H0111", planId: "001", segmentId: "000" }, status: "switched" },
  { id: "pt-104", fullName: "Derek Okonkwo", rxcui: "1091650", plan: { contractId: "H5422", planId: "011", segmentId: "000" }, status: "new" },
  { id: "pt-105", fullName: "Elena Vasquez", rxcui: "1091650", plan: { contractId: "H5422", planId: "015", segmentId: "000" }, status: "dismissed" },
  { id: "pt-106", fullName: "Farah Siddiqui", rxcui: "1091654", plan: { contractId: "H5422", planId: "011", segmentId: "000" }, status: "new" },
  { id: "pt-107", fullName: "George Hale", rxcui: "847910", plan: { contractId: "H8390", planId: "017", segmentId: "000" }, status: "new" },
  { id: "pt-108", fullName: "Helen Cho", rxcui: "847910", plan: { contractId: "H8390", planId: "017", segmentId: "000" }, status: "seen" },
  { id: "pt-109", fullName: "Ivan Petrov", rxcui: "847915", plan: { contractId: "H8390", planId: "017", segmentId: "000" }, status: "switched" },
  { id: "pt-110", fullName: "Julia Marsh", rxcui: "1486981", plan: { contractId: "H1112", planId: "038", segmentId: "000" }, status: "new" },
  { id: "pt-111", fullName: "Kenji Watanabe", rxcui: "1091654", plan: { contractId: "H5422", planId: "015", segmentId: "000" }, status: "new" },
  { id: "pt-112", fullName: "Lila Grant", rxcui: "847915", plan: { contractId: "H8390", planId: "015", segmentId: "000" }, status: "new" },
];

async function ensureDoctor(db: Db, id: string, fullName: string): Promise<void> {
  const existing = await db.query<{ id: string }>("SELECT id FROM doctors WHERE id = $1", [id]);
  if (existing.length > 0) return;
  await db.run("INSERT INTO doctors (id, full_name, phone) VALUES ($1, $2, NULL)", [id, fullName]);
}

async function changeIdFor(db: Db, rxcui: string, plan: Plan): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `SELECT c.id
       FROM coverage_changes c
       JOIN plans pl ON pl.data_version = 'v2-cms'
                    AND pl.formulary_id = c.formulary_id
                    AND pl.contract_id = $2
                    AND pl.plan_id = $3
                    AND pl.segment_id = $4
      WHERE c.rxcui = $1 AND c.to_version = 'v2-cms' AND c.change_type = 'removed'`,
    [rxcui, plan.contractId, plan.planId, plan.segmentId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`No real removal for ${rxcui} on ${plan.contractId}-${plan.planId}-${plan.segmentId}`);
  return id;
}

export async function seedDemoPanel(db: Db): Promise<void> {
  await ensureDoctor(db, ARCHIVE_DOCTOR.id, ARCHIVE_DOCTOR.fullName);
  await ensureDoctor(db, DEMO_DOCTOR_ID, "Dr. Maria Alvarez");
  await db.run("UPDATE prescriptions SET doctor_id = $1 WHERE doctor_id = $2 AND rxcui = $3", [
    ARCHIVE_DOCTOR.id,
    DEMO_DOCTOR_ID,
    NOVOLOG,
  ]);

  const changeIds = new Set<string>();
  for (const patient of DEMO_PANEL) {
    const existing = await db.query<{ id: string }>("SELECT id FROM patients WHERE id = $1", [patient.id]);
    if (existing.length === 0) {
      await db.run("INSERT INTO patients (id, full_name) VALUES ($1, $2)", [patient.id, patient.fullName]);
    }
    const coverage = await db.query<{ patient_id: string }>("SELECT patient_id FROM patient_coverage WHERE patient_id = $1", [patient.id]);
    if (coverage.length === 0) {
      await db.run(
        "INSERT INTO patient_coverage (patient_id, contract_id, plan_id, segment_id) VALUES ($1, $2, $3, $4)",
        [patient.id, patient.plan.contractId, patient.plan.planId, patient.plan.segmentId],
      );
    }
    const rxId = `rx-${patient.id}`;
    const rx = await db.query<{ id: string }>("SELECT id FROM prescriptions WHERE id = $1", [rxId]);
    if (rx.length === 0) {
      await db.run(
        "INSERT INTO prescriptions (id, patient_id, doctor_id, rxcui, started_at) VALUES ($1, $2, $3, $4, $5)",
        [rxId, patient.id, DEMO_DOCTOR_ID, patient.rxcui, STARTED_AT],
      );
    }
    changeIds.add(await changeIdFor(db, patient.rxcui, patient.plan));
  }

  await matchPrescriptions([...changeIds], db);

  for (const patient of DEMO_PANEL) {
    await db.run("UPDATE patient_alerts SET status = $1 WHERE patient_id = $2", [patient.status, patient.id]);
  }
}

async function integrity(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const patient of DEMO_PANEL) {
    if (seen.has(patient.id)) problems.push(`Duplicate demo id ${patient.id}`);
    seen.add(patient.id);
    const alts = await findAlternatives(patient.plan, patient.rxcui, { db, dataVersion: "v2-cms" });
    if (alts.length < 2) problems.push(`${patient.id} ${patient.rxcui} has ${alts.length} formulary alternatives`);
    if (alts.some((alt) => alt.estMonthlyCost == null)) problems.push(`${patient.id} has an alternative with no price`);
    if (alts.every((alt) => alt.estMonthlyCost === 0)) {
      problems.push(`${patient.id} alternatives all estimate $0 (engine output, not a missing price)`);
    }
  }
  const orphans = await db.query<{ id: string }>(
    `SELECT p.id FROM patients p
      LEFT JOIN prescriptions rx ON rx.patient_id = p.id
     WHERE rx.id IS NULL AND p.id LIKE 'pt-1%'`,
  );
  for (const row of orphans) problems.push(`Patient ${row.id} has no prescription`);
  const badPlans = await db.query<{ patient_id: string }>(
    `SELECT pc.patient_id
       FROM patient_coverage pc
       LEFT JOIN plans pl ON pl.data_version = 'v2-cms'
                         AND pl.contract_id = pc.contract_id
                         AND pl.plan_id = pc.plan_id
                         AND pl.segment_id = pc.segment_id
      WHERE pl.contract_id IS NULL AND pc.patient_id LIKE 'pt-1%'`,
  );
  for (const row of badPlans) problems.push(`Patient ${row.patient_id} plan is not in v2-cms`);
  const phones = await db.query<{ n: number }>(
    "SELECT count(*) AS n FROM patients WHERE id LIKE 'pt-1%'",
  );
  if (Number(phones[0]?.n ?? 0) > 0) {
    problems.push("Demo patients have no phone column. SMS cannot be delivered.");
  }
  return problems;
}

async function main() {
  const db = await openDb();
  await seedDemoPanel(db);
  const rows = await db.query<{ id: string; full_name: string; status: string; drug: string; plan_name: string; alts: string | null }>(
    `SELECT p.id, p.full_name, a.status, d.name AS drug, pl.plan_name, alt.name AS alts
       FROM patients p
       JOIN prescriptions rx ON rx.patient_id = p.id AND rx.doctor_id = $1
       JOIN patient_alerts a ON a.prescription_id = rx.id
       JOIN coverage_changes c ON c.id = a.change_id
       LEFT JOIN drugs d ON d.rxcui = c.rxcui
       LEFT JOIN drugs alt ON alt.rxcui = a.best_alternative_rxcui
       LEFT JOIN patient_coverage pc ON pc.patient_id = p.id
       LEFT JOIN plans pl ON pl.data_version = 'v2-cms'
                         AND pl.contract_id = pc.contract_id
                         AND pl.plan_id = pc.plan_id
                         AND pl.segment_id = pc.segment_id
      ORDER BY p.full_name`,
    [DEMO_DOCTOR_ID],
  );
  console.log(JSON.stringify(rows, null, 2));
  const problems = await integrity(db);
  console.log("INTEGRITY");
  for (const problem of problems) console.log(`- ${problem}`);
  await db.close();
  const blocking = problems.filter((problem) => !problem.includes("$0") && !problem.startsWith("Demo patients have no phone"));
  if (blocking.length > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
