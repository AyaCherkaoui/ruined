import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPath, openDb, type Db } from "./db";
import { addDoctor, addDrug, addPatient, addPrescription, TEST_FORMULARY, TEST_PLAN } from "./testing";
import { alertsForDoctor, dismissAlert, resetAlertStatuses, runCheck, searchPatientDrugs, searchPatients } from "./queries";
import { CURRENT_DATA_VERSION } from "./scenario";

const TMP = `${dbPath()}.queries-test.duckdb`;
let db: Db;

beforeAll(async () => {
  fs.rmSync(TMP, { force: true });
  db = await openDb({ path: TMP });
  await addDoctor(db, "doc-001", "Dr. Maria Alvarez");
  await addPatient(db, "pt-001", "Diane Whitfield", TEST_PLAN);
  await addDrug(db, { rxcui: "1653204", name: "3 ML insulin aspart, human 100 UNT/ML Pen Injector [NovoLog]", ingredient: "insulin", classId: null, tier: 3, unit: 10 });
  await addPrescription(db, "rx-001", "pt-001", "doc-001", "1653204");
  await db.run(
    `INSERT INTO plans (data_version, contract_id, plan_id, segment_id, plan_name, formulary_id, snp)
     VALUES ($1, $2, $3, $4, 'Test Plan', $5, '0')`,
    [CURRENT_DATA_VERSION, TEST_PLAN.contractId, TEST_PLAN.planId, TEST_PLAN.segmentId, TEST_FORMULARY],
  );
  await db.run(
    `INSERT INTO coverage_changes (id, from_version, to_version, formulary_id, rxcui, change_type,
        old_tier, new_tier, old_pa, new_pa, old_st, new_st, old_ql, new_ql, detected_at)
     VALUES ('chg-1', 'v1', $1, $2, '1653204', 'removed', 3, NULL, false, false, false, false, false, false, CURRENT_TIMESTAMP)`,
    [CURRENT_DATA_VERSION, TEST_FORMULARY],
  );
  await db.run(
    `INSERT INTO patient_alerts (id, change_id, patient_id, prescription_id, contract_id, plan_id,
        old_monthly_cost, new_monthly_cost, best_alternative_rxcui, best_alternative_cost, status, created_at)
     VALUES ('al-1', 'chg-1', 'pt-001', 'rx-001', $1, $2, 47, NULL, NULL, NULL, 'new', CURRENT_TIMESTAMP)`,
    [TEST_PLAN.contractId, TEST_PLAN.planId],
  );
});

afterAll(async () => {
  await db.close();
  fs.rmSync(TMP, { force: true });
});

describe("scenario queries", () => {
  it("returns the doctor's alert with the joined drug and plan name", async () => {
    const alerts = await alertsForDoctor("doc-001", db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "al-1",
      patientId: "pt-001",
      patientName: "Diane Whitfield",
      changeType: "removed",
      planName: "Test Plan",
      oldMonthlyCost: 47,
      newMonthlyCost: null,
      bestAlternativeRxcui: null,
      bestAlternativeName: null,
      status: "new",
    });
    expect(alerts[0].drugName).toContain("NovoLog");
  });

  it("searches patients by name and lists their prescriptions", async () => {
    const patients = await searchPatients("diane", db);
    expect(patients.map((patient) => patient.fullName)).toEqual(["Diane Whitfield"]);
    expect(patients[0].plan.planName).toBe("Test Plan");
    const drugs = await searchPatientDrugs("pt-001", "novo", db);
    expect(drugs).toHaveLength(1);
    expect(drugs[0].rxcui).toBe("1653204");
  });

  it("checks coverage against the current data version", async () => {
    const result = await runCheck({ patientId: "pt-001", rxcui: "1653204" }, db);
    expect(result.coverage.status).toBe("not_covered");
    expect(result.coverage.isEstimate).toBe(true);
    expect(result.alternatives).toEqual([]);
  });

  it("dismisses an alert and reset clears the status", async () => {
    const dismissed = await dismissAlert("al-1", db);
    expect(dismissed.status).toBe("dismissed");
    expect((await alertsForDoctor("doc-001", db))[0].status).toBe("dismissed");
    await expect(dismissAlert("missing", db)).rejects.toThrow(/not found/i);
    await resetAlertStatuses(db);
    expect((await alertsForDoctor("doc-001", db))[0].status).toBe("new");
  });
});
