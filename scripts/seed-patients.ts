/**
 * Seed 20 SYNTHETIC patients on real Georgia Part D plans (2-4 common meds each).
 * Names, ages and languages are invented; plans and drugs are real CMS / RxNorm identifiers.
 *
 *   npx tsx scripts/seed-patients.ts       # idempotent: replaces the seeded roster
 *
 * Deterministic (no randomness). Validates every plan and drug against the loaded data before inserting.
 * Stop the dev server first: DuckDB allows one writer.
 *
 * Roster design: 7 patients take a brand / high-cost drug ("expensive": Ozempic, Eliquis, Trulicity,
 * Tradjenta + Jardiance, Lumigan + Edarbi, Toujeo, Myrbetriq + Synthroid); the other 13 take common
 * generics. Only non-SNP plans are used: dual-eligible / institutional plans have low-income-subsidy
 * cost sharing that plan-level estimates do not capture.
 *
 * `api` branch, task 1: 4 of the 13 generic-only patients (pt-009, pt-012, pt-018, pt-020) also take
 * Rybelsus (oral semaglutide), added after it was found removed from EVERY roster plan's formulary in
 * the real September 2026 CMS monthly PUF (data_version 'v2-cms', scripts/load_puf_monthly.py) --
 * see PROGRESS.md task 1 and lib/patientAlerts.test.ts. 3 of those 4 cross the $50/mo "expensive"
 * line on their own plan's v1 cost share even before the removal (pt-012's copay plan keeps her at
 * exactly $47), which is why lib/patients.test.ts and lib/dashboard.test.ts now expect 10, not 7.
 */
import { openDb } from "../lib/db";
import { coverageForRxcuis, loadPlanContext } from "../lib/coverage";

type PlanKey = { contractId: string; planId: string; segmentId: string };

const PLANS = {
  humanaBasic: { contractId: "S5884", planId: "135", segmentId: "000" }, // PDP, 25% coinsurance on brands
  wellcareClassic: { contractId: "S4802", planId: "082", segmentId: "000" }, // PDP
  aarpPreferred: { contractId: "S5921", planId: "392", segmentId: "000" }, // PDP, 16% coinsurance
  aarpSaver: { contractId: "S5921", planId: "355", segmentId: "000" }, // PDP
  silverScript: { contractId: "S5601", planId: "020", segmentId: "000" }, // PDP
  healthSpring: { contractId: "H0439", planId: "006", segmentId: "000" }, // HMO, flat copays
  wellcareSimple: { contractId: "H0111", planId: "001", segmentId: "000" }, // PPO
  aetnaSignature: { contractId: "H1109", planId: "005", segmentId: "000" }, // HMO
  humanaGold: { contractId: "H4141", planId: "015", segmentId: "000" }, // HMO
  humanaChoice: { contractId: "H5216", planId: "073", segmentId: "000" }, // PPO
  uhcGa2: { contractId: "H1889", planId: "013", segmentId: "000" }, // PPO
  anthem: { contractId: "H4036", planId: "030", segmentId: "000" }, // PPO
  blueAdvantage: { contractId: "H7917", planId: "040", segmentId: "000" }, // PPO
  clover: { contractId: "H5141", planId: "026", segmentId: "000" }, // PPO
  devoted: { contractId: "H5453", planId: "001", segmentId: "000" }, // PPO
  kaiser: { contractId: "H1170", planId: "002", segmentId: "000" }, // HMO
} satisfies Record<string, PlanKey>;

// rxcui -> what it is (RxNorm names are read from the drug cache; these labels are for the reader)
const RX = {
  ozempic: "2619154", eliquis: "1364447", trulicity: "1551300", tradjenta: "1100706", jardiance: "1545664",
  lumigan: "1009341", edarbi: "1091650", toujeo: "2002420", myrbetriq: "1300803", synthroid: "966247",
  atorvastatin40: "617311", atorvastatin10: "617312", lisinopril20: "314077", lisinopril10: "314076",
  metformin500: "861007", metformin1000: "861004", amlodipine5: "197361", amlodipine10: "308135",
  losartan50: "979492", metoprolol50: "866436", omeprazole20: "198051", gabapentin300: "310431",
  sertraline50: "312941", hctz25: "310798", furosemide40: "313988", tamsulosin: "863669",
  levothyroxine50: "966221", simvastatin20: "312961", clopidogrel75: "309362", glipizide5: "310490",
  rosuvastatin20: "859751", carvedilol12: "200032", pravastatin40: "904475", montelukast10: "200224",
  allopurinol100: "197319", finasteride5: "310346",
  rybelsus14: "2200650", // added task 1 (api branch): removed from every roster plan's v2-cms (Sept 2026) formulary
} as const;

interface Seed {
  id: string;
  name: string;
  age: number;
  language: string;
  plan: PlanKey;
  meds: [rxcui: string, dose: string][];
}

const ROSTER: Seed[] = [
  // --- 7 patients on expensive / brand drugs -------------------------------------------------
  { id: "pt-001", name: "Dorothy Washington", age: 74, language: "English", plan: PLANS.humanaBasic,
    meds: [[RX.ozempic, "0.5 mg once weekly"], [RX.metformin1000, "1000 mg twice daily"], [RX.atorvastatin40, "40 mg at bedtime"]] },
  { id: "pt-002", name: "Robert Jenkins", age: 79, language: "English", plan: PLANS.humanaBasic,
    meds: [[RX.eliquis, "5 mg twice daily"], [RX.metoprolol50, "50 mg once daily"], [RX.atorvastatin40, "40 mg at bedtime"], [RX.lisinopril20, "20 mg once daily"]] },
  { id: "pt-003", name: "Maria Gonzalez", age: 68, language: "Spanish", plan: PLANS.wellcareClassic,
    meds: [[RX.trulicity, "1.5 mg once weekly"], [RX.metformin1000, "1000 mg twice daily"], [RX.losartan50, "50 mg once daily"]] },
  { id: "pt-004", name: "Harold Bennett", age: 81, language: "English", plan: PLANS.humanaBasic,
    meds: [[RX.tradjenta, "5 mg once daily"], [RX.jardiance, "10 mg once daily"], [RX.metformin500, "500 mg twice daily"]] },
  { id: "pt-005", name: "Linda Nguyen", age: 71, language: "Vietnamese", plan: PLANS.aarpPreferred,
    meds: [[RX.lumigan, "1 drop each eye at bedtime"], [RX.edarbi, "40 mg once daily"], [RX.amlodipine10, "10 mg once daily"]] },
  { id: "pt-006", name: "James Carter", age: 77, language: "English", plan: PLANS.humanaBasic,
    meds: [[RX.toujeo, "30 units at bedtime"], [RX.metformin1000, "1000 mg twice daily"], [RX.lisinopril20, "20 mg once daily"]] },
  { id: "pt-007", name: "Evelyn Park", age: 83, language: "Korean", plan: PLANS.humanaBasic,
    meds: [[RX.myrbetriq, "50 mg once daily"], [RX.synthroid, "50 mcg once daily"], [RX.amlodipine5, "5 mg once daily"]] },

  // --- 13 patients on common generics ---------------------------------------------------------
  { id: "pt-008", name: "Barbara Thompson", age: 72, language: "English", plan: PLANS.healthSpring,
    meds: [[RX.atorvastatin40, "40 mg at bedtime"], [RX.lisinopril20, "20 mg once daily"]] },
  { id: "pt-009", name: "Carlos Ramirez", age: 69, language: "Spanish", plan: PLANS.wellcareSimple,
    meds: [[RX.metformin500, "500 mg twice daily"], [RX.glipizide5, "5 mg once daily"], [RX.losartan50, "50 mg once daily"], [RX.rybelsus14, "14 mg once daily"]] },
  { id: "pt-010", name: "Susan Miller", age: 66, language: "English", plan: PLANS.aetnaSignature,
    meds: [[RX.levothyroxine50, "50 mcg once daily"], [RX.amlodipine5, "5 mg once daily"], [RX.sertraline50, "50 mg once daily"], [RX.omeprazole20, "20 mg once daily"]] },
  { id: "pt-011", name: "William Brown", age: 85, language: "English", plan: PLANS.humanaGold,
    meds: [[RX.metoprolol50, "50 mg once daily"], [RX.furosemide40, "40 mg once daily"], [RX.lisinopril20, "20 mg once daily"], [RX.atorvastatin10, "10 mg at bedtime"]] },
  { id: "pt-012", name: "Fatima Ali", age: 70, language: "Arabic", plan: PLANS.humanaChoice,
    meds: [[RX.metformin1000, "1000 mg twice daily"], [RX.simvastatin20, "20 mg at bedtime"], [RX.hctz25, "25 mg once daily"], [RX.rybelsus14, "14 mg once daily"]] },
  { id: "pt-013", name: "Hyun-woo Kim", age: 76, language: "Korean", plan: PLANS.uhcGa2,
    meds: [[RX.amlodipine10, "10 mg once daily"], [RX.losartan50, "50 mg once daily"], [RX.rosuvastatin20, "20 mg at bedtime"]] },
  { id: "pt-014", name: "Patricia Johnson", age: 88, language: "English", plan: PLANS.anthem,
    meds: [[RX.gabapentin300, "300 mg three times daily"], [RX.sertraline50, "50 mg once daily"], [RX.omeprazole20, "20 mg once daily"]] },
  { id: "pt-015", name: "Miguel Torres", age: 73, language: "Spanish", plan: PLANS.blueAdvantage,
    meds: [[RX.tamsulosin, "0.4 mg once daily"], [RX.finasteride5, "5 mg once daily"], [RX.lisinopril10, "10 mg once daily"]] },
  { id: "pt-016", name: "Grace Okafor", age: 67, language: "English", plan: PLANS.silverScript,
    meds: [[RX.atorvastatin40, "40 mg at bedtime"], [RX.amlodipine5, "5 mg once daily"]] },
  { id: "pt-017", name: "Thomas Anderson", age: 80, language: "English", plan: PLANS.clover,
    meds: [[RX.clopidogrel75, "75 mg once daily"], [RX.atorvastatin40, "40 mg at bedtime"], [RX.carvedilol12, "12.5 mg twice daily"], [RX.lisinopril20, "20 mg once daily"]] },
  { id: "pt-018", name: "Tran Van Nguyen", age: 75, language: "Vietnamese", plan: PLANS.devoted,
    meds: [[RX.metformin500, "500 mg twice daily"], [RX.pravastatin40, "40 mg at bedtime"], [RX.losartan50, "50 mg once daily"], [RX.rybelsus14, "14 mg once daily"]] },
  { id: "pt-019", name: "Ruth Cohen", age: 84, language: "English", plan: PLANS.kaiser,
    meds: [[RX.levothyroxine50, "50 mcg once daily"], [RX.allopurinol100, "100 mg once daily"], [RX.hctz25, "25 mg once daily"]] },
  { id: "pt-020", name: "Anita Sharma", age: 72, language: "Hindi", plan: PLANS.aarpSaver,
    meds: [[RX.montelukast10, "10 mg once daily"], [RX.atorvastatin10, "10 mg at bedtime"], [RX.metformin500, "500 mg twice daily"], [RX.rybelsus14, "14 mg once daily"]] },
];

async function main() {
  const db = await openDb();

  // Validate the roster against the real data before touching anything
  const problems: string[] = [];
  for (const p of ROSTER) {
    if (p.meds.length < 2 || p.meds.length > 4) problems.push(`${p.id}: needs 2-4 meds`);
    const plan = await db.query<{ snp: string; plan_name: string }>(
      "SELECT snp, plan_name FROM plans WHERE data_version = 'v1' AND contract_id = $1 AND plan_id = $2 AND segment_id = $3",
      [p.plan.contractId, p.plan.planId, p.plan.segmentId],
    );
    if (plan.length === 0) problems.push(`${p.id}: plan ${p.plan.contractId}-${p.plan.planId}-${p.plan.segmentId} not in data`);
    else if (plan[0].snp !== "0") problems.push(`${p.id}: ${plan[0].plan_name} is a SNP plan (LIS/institutional cost sharing not modeled)`);
    for (const [rxcui] of p.meds) {
      const d = await db.query("SELECT 1 FROM drugs WHERE rxcui = $1", [rxcui]);
      if (d.length === 0) problems.push(`${p.id}: rxcui ${rxcui} not in drug cache`);
    }
  }
  if (problems.length > 0) throw new Error("Roster problems:\n  " + problems.join("\n  "));

  await db.run("DELETE FROM patient_meds");
  await db.run("DELETE FROM patients");
  let expensive = 0;
  for (const p of ROSTER) {
    await db.run(
      "INSERT INTO patients (id, name, age, language, contract_id, plan_id, segment_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [p.id, p.name, p.age, p.language, p.plan.contractId, p.plan.planId, p.plan.segmentId],
    );
    const drugs = await db.query<{ rxcui: string; name: string }>(
      `SELECT rxcui, name FROM drugs WHERE rxcui IN (${p.meds.map((_, i) => `$${i + 1}`).join(", ")})`,
      p.meds.map(([r]) => r),
    );
    const nameOf = new Map(drugs.map((d) => [d.rxcui, d.name]));
    for (const [rxcui, dose] of p.meds) {
      await db.run("INSERT INTO patient_meds (patient_id, rxcui, drug_name, dose) VALUES ($1, $2, $3, $4)", [p.id, rxcui, nameOf.get(rxcui)!, dose]);
    }

    const cov = await coverageForRxcuis(db, await loadPlanContext(db, p.plan), p.meds.map(([r]) => r));
    const worst = [...cov.values()].sort((a, b) => (b.estMonthlyCost ?? 0) - (a.estMonthlyCost ?? 0))[0];
    const uncovered = [...cov.values()].filter((c) => c.status === "not_covered").map((c) => c.drugName);
    if ((worst.estMonthlyCost ?? 0) >= 50) expensive++;
    console.log(
      `${p.id} ${p.name.padEnd(19)} ${p.plan.contractId}-${p.plan.planId} ${p.meds.length} meds  costliest: ${worst.drugName.slice(0, 44).padEnd(44)} ~$${worst.estMonthlyCost}/mo` +
        (uncovered.length ? `  NOT COVERED: ${uncovered.join(", ")}` : ""),
    );
  }
  console.log(`\nseeded ${ROSTER.length} synthetic patients; ${expensive} with a med costing >= $50/month`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
