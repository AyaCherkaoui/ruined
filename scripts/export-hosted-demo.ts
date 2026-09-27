/** Export a read-only copy of the original CMS-backed demo, never real patient data. */
import fs from "node:fs/promises";
import { openDbSnapshot, closeDbSnapshot } from "../lib/db";
import { alertsForDoctor, runCheck } from "../lib/queries";
import { listAppChanges } from "../lib/pipeline/app-runner";
import { ndcsForPlanDrug } from "../lib/insurer-check";
import type { CheckResponse } from "../lib/contract";

async function main() {
  const snapshot = await openDbSnapshot("hosted-export");
  const db = snapshot.db;
  try {
    const alerts = await alertsForDoctor("doc-001", db);
    if (alerts.length !== 136 || alerts.some(a => !/^(pt-10[123789]|pt-110|pt-112|demo-pt-\d{3})$/.test(a.patientId))) {
      throw new Error("Expected the original 136 synthetic demo patients; refusing an unknown dataset");
    }
    const checks: { id:string; contract_id:string; plan_id:string; segment_id:string; rxcui:string; plan_name:string; data_version:string; result:CheckResponse; ndcs:string[] }[] = [];
    const plans: Record<string,unknown>[] = [];
    const evidence: {key:string;version:string;formularyId:string;rxcui:string;rows:Record<string,unknown>[]}[] = [];
    for (const alert of alerts) {
      const id = [alert.contractId, alert.planId, alert.segmentId, alert.rxcui].join(":");
      if (checks.some(c => c.id === id)) continue;
      const plan = { contractId: alert.contractId, planId: alert.planId, segmentId: alert.segmentId };
      const result = await runCheck({ ...plan, rxcui: alert.rxcui }, db);
      if (result.coverage.status !== "not_covered" || result.alternatives.length < 2) throw new Error(`Invalid demo check ${id}`);
      checks.push({ id, contract_id: plan.contractId, plan_id: plan.planId, segment_id: plan.segmentId,
        rxcui: alert.rxcui, plan_name: alert.planName, data_version: "v2-cms", result,
        ndcs: await ndcsForPlanDrug(db, plan, alert.rxcui) });
      for (const version of ["v1", "v2-cms"]) {
        const [sourcePlan] = await db.query<Record<string, unknown>>(
          "SELECT * FROM plans WHERE data_version=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4",
          [version, plan.contractId, plan.planId, plan.segmentId]);
        if (!sourcePlan) throw new Error(`Missing plan ${id} ${version}`);
        if (!plans.some(p => JSON.stringify(p) === JSON.stringify(sourcePlan))) plans.push(sourcePlan);
        const rxcuis = [alert.rxcui, ...result.alternatives.map(a => a.rxcui)];
        for (const rxcui of rxcuis) {
          const formularyId = String(sourcePlan.formulary_id);
          const key = `${version}:${formularyId}:${rxcui}`;
          if (evidence.some(e => e.key === key)) continue;
          const rows = await db.query<Record<string, unknown>>(
            "SELECT ndc,tier,prior_authorization,step_therapy,quantity_limit,quantity_limit_amount,quantity_limit_days FROM formulary WHERE data_version=$1 AND formulary_id=$2 AND rxcui=$3 ORDER BY ndc",
            [version, formularyId, rxcui]);
          evidence.push({ key, version, formularyId, rxcui, rows });
        }
      }
    }
    const patientRows = await db.query<{ id: string; full_name: string; contract_id: string; plan_id: string; segment_id: string }>(
      `SELECT p.*,pc.contract_id,pc.plan_id,pc.segment_id FROM patients p JOIN patient_coverage pc ON pc.patient_id=p.id
       WHERE EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.patient_id=p.id AND rx.doctor_id='doc-001') ORDER BY p.id`);
    const patients = patientRows.map(p => ({ id: p.id, full_name: p.full_name, doctor_id: "doc-001", is_synthetic: true,
      plan: { contractId: p.contract_id, planId: p.plan_id, segmentId: p.segment_id,
        planName: alerts.find(a => a.patientId === p.id)!.planName },
      prescriptions: alerts.filter(a => a.patientId === p.id).map(a => ({ id: a.prescriptionId, rxcui: a.rxcui, drugName: a.drugName })) }));
    const changes = await listAppChanges(db);
    const sources = await db.query("SELECT * FROM data_versions ORDER BY id");
    const hasReceipts = (await db.query("SELECT 1 FROM information_schema.tables WHERE table_name='policy_notifications' AND table_schema='main'")).length > 0;
    const notificationReceipts = hasReceipts ? await db.query<{id:string;result:string;created_at:string}>("SELECT * FROM policy_notifications") : [];
    const initialReviews = alerts.filter(a=>a.selectedAlternative).map(a=>({alert_id:a.id,status:a.status,
      selected_rxcui:a.selectedAlternative!.rxcui,saved_at:a.selectedAlternative!.savedAt}));
    const coverageAlerts = checks.map(check => {
      const a = alerts.find(a => a.contractId === check.contract_id && a.planId === check.plan_id && a.rxcui === check.rxcui)!;
      const change = changes.find(c => c.id === a.changeId)!;
      return { id: `cms-${a.changeId}-${a.contractId}-${a.planId}-${a.segmentId}`,
        insurer: a.planName.startsWith("Wellcare") ? "Wellcare" : "CareSource", plan_id: `${a.contractId}-${a.planId}`,
        plan_name: a.planName, drug: a.drugName, rxcui: a.rxcui, change_type: "dropped",
        old_value: `Listed in Q2 2026 CMS snapshot on tier ${a.oldTier}. Prior authorization: ${change.oldPriorAuth ? "yes" : "no"}. Quantity limit: ${change.oldQuantityLimit ? "yes" : "no"}.`,
        new_value: "Not listed for this RxCUI in the September 2026 CMS snapshot. Historical snapshot comparison; verify with the plan before prescribing.",
        effective_date: null, detected_at: a.detectedAt,
        source: "CMS Q2 2026 SPUF vs September 2026 monthly PUF; exact product-level comparison. Patient identities and enrollment are synthetic. Effective change date not supplied. September cost estimates reuse Q2 pricing.",
        source_url: String((sources[1] as {source:string}).source), is_demo: false };
    });
    const output = { patients, checks, alerts: alerts.map(a => ({ id: a.id, doctor_id: "doc-001", patient_id: a.patientId,
      check_id: [a.contractId,a.planId,a.segmentId,a.rxcui].join(":"), change_id: a.changeId,
      payload: { ...a, selectedAlternative: null } })), changes: changes.map(c => ({id:c.id,payload:c})),
      doctors: [{id:"doc-001",full_name:"Dr. Maria Alvarez",phone:null}], sources, plans, evidence, coverageAlerts,
      initialReviews, notificationReceipts:notificationReceipts.map(r=>({...r,result:JSON.parse(r.result)})) };
    await fs.mkdir("data/raw/hosted-demo", { recursive: true });
    await fs.writeFile("data/raw/hosted-demo/export.json", JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ patients: patients.length, alerts: alerts.length, checks: checks.length, changes: changes.length, evidence: evidence.length,
      savedChoices:initialReviews.length,notificationReceipts:notificationReceipts.length }));
  } finally { await closeDbSnapshot(snapshot); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
