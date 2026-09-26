import { displayDrugName, estMoney } from "../../components/format";
import type { Digest, PatientAlert, PatientMessage } from "./alert-types";
import type { Alternative, CheckResponse, Patient, Plan } from "@/lib/contract";

/**
 * Search routes are still being built. While this is true, patient search, drug search,
 * and the upcoming-change list return local fixtures. Coverage checks always hit POST /api/check.
 * Alert inbox routes use USE_ALERT_MOCKS the same way.
 */
export const USE_MOCKS = true;

/** Digest and alert actions. While true, they read and update an in-memory store. */
export const USE_ALERT_MOCKS = true;

export interface DrugHit {
  rxcui: string;
  drugName: string;
  displayName: string;
}

/** One drug on one patient whose plan tier (and cost) is about to change. */
export interface UpcomingRisk {
  patientId: string;
  patientName: string;
  age: number;
  language: string;
  rxcui: string;
  drugName: string;
  displayName: string;
  oldTier: number;
  newTier: number;
  oldMonthlyCost: number;
  newMonthlyCost: number;
  /** Whole-number percent, so 36 means +36%. */
  percentIncrease: number;
  effectiveDate: string;
  bestAlternative: Alternative | null;
}

const PLANS = {
  humanaBasic: { contractId: "S5884", planId: "135", segmentId: "000", planName: "Humana Basic Rx Plan (PDP)" },
  wellcareClassic: { contractId: "S4802", planId: "082", segmentId: "000", planName: "Wellcare Classic (PDP)" },
  aarpPreferred: { contractId: "S5921", planId: "392", segmentId: "000", planName: "AARP Medicare Rx Preferred from UHC (PDP)" },
  aarpSaver: { contractId: "S5921", planId: "355", segmentId: "000", planName: "AARP Medicare Rx Saver from UHC (PDP)" },
  silverScript: { contractId: "S5601", planId: "020", segmentId: "000", planName: "SilverScript Choice (PDP)" },
  healthSpring: { contractId: "H0439", planId: "006", segmentId: "000", planName: "HealthSpring Preferred Plus (HMO)" },
  wellcareSimple: { contractId: "H0111", planId: "001", segmentId: "000", planName: "Wellcare Simple Open (PPO)" },
  aetnaSignature: { contractId: "H1109", planId: "005", segmentId: "000", planName: "Aetna Medicare Signature (HMO)" },
  humanaGold: { contractId: "H4141", planId: "015", segmentId: "000", planName: "Humana Gold Plus H4141-015 (HMO)" },
  humanaChoice: { contractId: "H5216", planId: "073", segmentId: "000", planName: "HumanaChoice H5216-073 (PPO)" },
  uhcGa2: { contractId: "H1889", planId: "013", segmentId: "000", planName: "UHC Medicare Advantage GA-2 (PPO)" },
  anthem: { contractId: "H4036", planId: "030", segmentId: "000", planName: "Anthem Medicare Advantage 2 (PPO)" },
  blueAdvantage: { contractId: "H7917", planId: "040", segmentId: "000", planName: "BlueAdvantage Sapphire (PPO)" },
  clover: { contractId: "H5141", planId: "026", segmentId: "000", planName: "Clover Health LiveHealthy (PPO)" },
  devoted: { contractId: "H5453", planId: "001", segmentId: "000", planName: "DEVOTED CHOICE 001 GA (PPO)" },
  kaiser: { contractId: "H1170", planId: "002", segmentId: "000", planName: "Kaiser Permanente Senior Advantage Enhanced 1 (HMO)" },
} as const satisfies Record<string, Plan>;

function med(rxcui: string, drugName: string, dose: string) {
  return { rxcui, drugName, dose };
}

const MOCK_PATIENTS: Patient[] = [
  {
    id: "pt-001", name: "Dorothy Washington", age: 74, language: "English", plan: PLANS.humanaBasic,
    meds: [
      med("2619154", "0.25 MG, 0.5 MG Dose 3 ML semaglutide 0.68 MG/ML Pen Injector [Ozempic]", "0.5 mg once weekly"),
      med("617311", "atorvastatin 40 MG Oral Tablet", "40 mg at bedtime"),
      med("861004", "metformin hydrochloride 1000 MG Oral Tablet", "1000 mg twice daily"),
    ],
  },
  {
    id: "pt-002", name: "Robert Jenkins", age: 79, language: "English", plan: PLANS.humanaBasic,
    meds: [
      med("1364447", "apixaban 5 MG Oral Tablet [Eliquis]", "5 mg twice daily"),
      med("866436", "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet", "50 mg once daily"),
      med("617311", "atorvastatin 40 MG Oral Tablet", "40 mg at bedtime"),
      med("314077", "lisinopril 20 MG Oral Tablet", "20 mg once daily"),
    ],
  },
  {
    id: "pt-003", name: "Maria Gonzalez", age: 68, language: "Spanish", plan: PLANS.wellcareClassic,
    meds: [
      med("1551300", "0.5 ML dulaglutide 1.5 MG/ML Auto-Injector [Trulicity]", "1.5 mg once weekly"),
      med("861004", "metformin hydrochloride 1000 MG Oral Tablet", "1000 mg twice daily"),
      med("979492", "losartan potassium 50 MG Oral Tablet", "50 mg once daily"),
    ],
  },
  {
    id: "pt-004", name: "Harold Bennett", age: 81, language: "English", plan: PLANS.humanaBasic,
    meds: [
      med("1100706", "linagliptin 5 MG Oral Tablet [Tradjenta]", "5 mg once daily"),
      med("1545664", "empagliflozin 10 MG Oral Tablet [Jardiance]", "10 mg once daily"),
      med("861007", "metformin hydrochloride 500 MG Oral Tablet", "500 mg twice daily"),
    ],
  },
  {
    id: "pt-005", name: "Linda Nguyen", age: 71, language: "Vietnamese", plan: PLANS.aarpPreferred,
    meds: [
      med("1009341", "bimatoprost 0.1 MG/ML Ophthalmic Solution [Lumigan]", "1 drop each eye at bedtime"),
      med("1091650", "azilsartan medoxomil 40 MG Oral Tablet [Edarbi]", "40 mg once daily"),
      med("308135", "amlodipine 10 MG Oral Tablet", "10 mg once daily"),
    ],
  },
  {
    id: "pt-006", name: "James Carter", age: 77, language: "English", plan: PLANS.humanaBasic,
    meds: [
      med("2002420", "3 ML insulin glargine 300 UNT/ML Pen Injector [Toujeo]", "30 units at bedtime"),
      med("861004", "metformin hydrochloride 1000 MG Oral Tablet", "1000 mg twice daily"),
      med("314077", "lisinopril 20 MG Oral Tablet", "20 mg once daily"),
    ],
  },
  {
    id: "pt-007", name: "Evelyn Park", age: 83, language: "Korean", plan: PLANS.humanaBasic,
    meds: [
      med("1300803", "24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]", "50 mg once daily"),
      med("966247", "levothyroxine sodium 0.05 MG Oral Tablet [Synthroid]", "50 mcg once daily"),
      med("197361", "amlodipine 5 MG Oral Tablet", "5 mg once daily"),
    ],
  },
  {
    id: "pt-008", name: "Barbara Thompson", age: 72, language: "English", plan: PLANS.healthSpring,
    meds: [
      med("617311", "atorvastatin 40 MG Oral Tablet", "40 mg at bedtime"),
      med("314077", "lisinopril 20 MG Oral Tablet", "20 mg once daily"),
    ],
  },
  {
    id: "pt-009", name: "Carlos Ramirez", age: 69, language: "Spanish", plan: PLANS.wellcareSimple,
    meds: [
      med("861007", "metformin hydrochloride 500 MG Oral Tablet", "500 mg twice daily"),
      med("310490", "glipizide 5 MG Oral Tablet", "5 mg once daily"),
      med("979492", "losartan potassium 50 MG Oral Tablet", "50 mg once daily"),
    ],
  },
  {
    id: "pt-010", name: "Susan Miller", age: 66, language: "English", plan: PLANS.aetnaSignature,
    meds: [
      med("966221", "levothyroxine sodium 0.05 MG Oral Tablet", "50 mcg once daily"),
      med("197361", "amlodipine 5 MG Oral Tablet", "5 mg once daily"),
      med("312941", "sertraline 50 MG Oral Tablet", "50 mg once daily"),
      med("198051", "omeprazole 20 MG Delayed Release Oral Capsule", "20 mg once daily"),
    ],
  },
  {
    id: "pt-011", name: "William Brown", age: 85, language: "English", plan: PLANS.humanaGold,
    meds: [
      med("866436", "24 HR metoprolol succinate 50 MG Extended Release Oral Tablet", "50 mg once daily"),
      med("313988", "furosemide 40 MG Oral Tablet", "40 mg once daily"),
      med("314077", "lisinopril 20 MG Oral Tablet", "20 mg once daily"),
      med("617312", "atorvastatin 10 MG Oral Tablet", "10 mg at bedtime"),
    ],
  },
  {
    id: "pt-012", name: "Fatima Ali", age: 70, language: "Arabic", plan: PLANS.humanaChoice,
    meds: [
      med("861004", "metformin hydrochloride 1000 MG Oral Tablet", "1000 mg twice daily"),
      med("312961", "simvastatin 20 MG Oral Tablet", "20 mg at bedtime"),
      med("310798", "hydrochlorothiazide 25 MG Oral Tablet", "25 mg once daily"),
    ],
  },
  {
    id: "pt-013", name: "Hyun-woo Kim", age: 76, language: "Korean", plan: PLANS.uhcGa2,
    meds: [
      med("308135", "amlodipine 10 MG Oral Tablet", "10 mg once daily"),
      med("979492", "losartan potassium 50 MG Oral Tablet", "50 mg once daily"),
      med("859751", "rosuvastatin calcium 20 MG Oral Tablet", "20 mg at bedtime"),
    ],
  },
  {
    id: "pt-014", name: "Patricia Johnson", age: 88, language: "English", plan: PLANS.anthem,
    meds: [
      med("310431", "gabapentin 300 MG Oral Capsule", "300 mg three times daily"),
      med("312941", "sertraline 50 MG Oral Tablet", "50 mg once daily"),
      med("198051", "omeprazole 20 MG Delayed Release Oral Capsule", "20 mg once daily"),
    ],
  },
  {
    id: "pt-015", name: "Miguel Torres", age: 73, language: "Spanish", plan: PLANS.blueAdvantage,
    meds: [
      med("863669", "tamsulosin hydrochloride 0.4 MG Oral Capsule", "0.4 mg once daily"),
      med("310346", "finasteride 5 MG Oral Tablet", "5 mg once daily"),
      med("314076", "lisinopril 10 MG Oral Tablet", "10 mg once daily"),
    ],
  },
  {
    id: "pt-016", name: "Grace Okafor", age: 67, language: "English", plan: PLANS.silverScript,
    meds: [
      med("617311", "atorvastatin 40 MG Oral Tablet", "40 mg at bedtime"),
      med("197361", "amlodipine 5 MG Oral Tablet", "5 mg once daily"),
    ],
  },
  {
    id: "pt-017", name: "Thomas Anderson", age: 80, language: "English", plan: PLANS.clover,
    meds: [
      med("309362", "clopidogrel 75 MG Oral Tablet", "75 mg once daily"),
      med("617311", "atorvastatin 40 MG Oral Tablet", "40 mg at bedtime"),
      med("200032", "carvedilol 12.5 MG Oral Tablet", "12.5 mg twice daily"),
      med("314077", "lisinopril 20 MG Oral Tablet", "20 mg once daily"),
    ],
  },
  {
    id: "pt-018", name: "Tran Van Nguyen", age: 75, language: "Vietnamese", plan: PLANS.devoted,
    meds: [
      med("861007", "metformin hydrochloride 500 MG Oral Tablet", "500 mg twice daily"),
      med("904475", "pravastatin sodium 40 MG Oral Tablet", "40 mg at bedtime"),
      med("979492", "losartan potassium 50 MG Oral Tablet", "50 mg once daily"),
    ],
  },
  {
    id: "pt-019", name: "Ruth Cohen", age: 84, language: "English", plan: PLANS.kaiser,
    meds: [
      med("966221", "levothyroxine sodium 0.05 MG Oral Tablet", "50 mcg once daily"),
      med("197319", "allopurinol 100 MG Oral Tablet", "100 mg once daily"),
      med("310798", "hydrochlorothiazide 25 MG Oral Tablet", "25 mg once daily"),
    ],
  },
  {
    id: "pt-020", name: "Anita Sharma", age: 72, language: "Hindi", plan: PLANS.aarpSaver,
    meds: [
      med("200224", "montelukast 10 MG Oral Tablet", "10 mg once daily"),
      med("617312", "atorvastatin 10 MG Oral Tablet", "10 mg at bedtime"),
      med("861007", "metformin hydrochloride 500 MG Oral Tablet", "500 mg twice daily"),
    ],
  },
];

const TROSPIUM: Alternative = {
  rxcui: "857560",
  drugName: "trospium chloride 20 MG Oral Tablet",
  status: "covered",
  tier: 4,
  priorAuth: false,
  stepTherapy: false,
  quantityLimit: false,
  estMonthlyCost: 9.32,
  isEstimate: true,
  monthlySavings: 101.17,
};

const JANUVIA: Alternative = {
  rxcui: "665044",
  drugName: "sitagliptin phosphate 50 MG Oral Tablet [Januvia]",
  status: "restricted",
  tier: 3,
  priorAuth: false,
  stepTherapy: false,
  quantityLimit: true,
  estMonthlyCost: 29.31,
  isEstimate: true,
  monthlySavings: 96.83,
};

const UPCOMING: UpcomingRisk[] = [
  {
    patientId: "pt-007",
    patientName: "Evelyn Park",
    age: 83,
    language: "Korean",
    rxcui: "1300803",
    drugName: "24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]",
    displayName: "Myrbetriq",
    oldTier: 3,
    newTier: 4,
    oldMonthlyCost: 110.49,
    newMonthlyCost: 150.27,
    percentIncrease: 36,
    effectiveDate: "2027-01-01",
    bestAlternative: TROSPIUM,
  },
  {
    patientId: "pt-006",
    patientName: "James Carter",
    age: 77,
    language: "English",
    rxcui: "2002420",
    drugName: "3 ML insulin glargine 300 UNT/ML Pen Injector [Toujeo]",
    displayName: "Toujeo",
    oldTier: 3,
    newTier: 4,
    oldMonthlyCost: 274.82,
    newMonthlyCost: 373.75,
    percentIncrease: 36,
    effectiveDate: "2027-01-01",
    bestAlternative: null,
  },
  {
    patientId: "pt-004",
    patientName: "Harold Bennett",
    age: 81,
    language: "English",
    rxcui: "1100706",
    drugName: "linagliptin 5 MG Oral Tablet [Tradjenta]",
    displayName: "Tradjenta",
    oldTier: 3,
    newTier: 4,
    oldMonthlyCost: 126.14,
    newMonthlyCost: 171.56,
    percentIncrease: 36,
    effectiveDate: "2027-01-01",
    bestAlternative: JANUVIA,
  },
];

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

function clonePatient(patient: Patient): Patient {
  return {
    ...patient,
    plan: { ...patient.plan },
    meds: patient.meds.map((item) => ({ ...item })),
  };
}

/** GET /api/patients/search?q= */
export async function searchPatients(q: string): Promise<Patient[]> {
  if (!USE_MOCKS) {
    return getJson<Patient[]>(`/api/patients/search?${new URLSearchParams({ q })}`);
  }
  const query = q.trim().toLowerCase();
  return MOCK_PATIENTS.filter((patient) => {
    if (!query) return true;
    const haystack = `${patient.name} ${patient.age} ${patient.language} ${patient.plan.planName}`.toLowerCase();
    return haystack.includes(query);
  })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(clonePatient);
}

/** GET /api/drugs/search?patientId=&q= — only medications on that patient's list. */
export async function searchDrugs(patientId: string, q: string): Promise<DrugHit[]> {
  if (!USE_MOCKS) {
    return getJson<DrugHit[]>(`/api/drugs/search?${new URLSearchParams({ patientId, q })}`);
  }
  const patient = MOCK_PATIENTS.find((item) => item.id === patientId);
  if (!patient) return [];
  const query = q.trim().toLowerCase();
  return patient.meds
    .map((item) => ({
      rxcui: item.rxcui,
      drugName: item.drugName,
      displayName: displayDrugName(item.drugName),
    }))
    .filter((drug) => {
      if (!query) return true;
      return drug.drugName.toLowerCase().includes(query) || drug.displayName.toLowerCase().includes(query);
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** POST /api/check — always the live coverage service. */
export async function checkDrug(patientId: string, rxcui: string): Promise<CheckResponse> {
  return getJson<CheckResponse>("/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId, rxcui }),
  });
}

/** GET /api/upcoming */
export async function getUpcoming(): Promise<UpcomingRisk[]> {
  if (!USE_MOCKS) return getJson<UpcomingRisk[]>("/api/upcoming");
  return UPCOMING.map((risk) => ({
    ...risk,
    bestAlternative: risk.bestAlternative ? { ...risk.bestAlternative } : null,
  }));
}

const OPEN_ALERT_STATUSES = new Set<PatientAlert["status"]>(["new", "seen"]);

function cloneAlert(alert: PatientAlert): PatientAlert {
  return {
    ...alert,
    bestAlternative: alert.bestAlternative ? { ...alert.bestAlternative } : null,
  };
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function sumMoney(values: Array<number | null | undefined>): number {
  const total = values.reduce<number>((sum, value) => sum + (value == null ? 0 : cents(value)), 0);
  return total / 100;
}

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function koreanDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${year}년 ${month}월 ${day}일`;
}

/** Savings are versus the post-change monthly cost, since that is the bill the switch avoids. */
function coveredAlternative(
  fields: Pick<Alternative, "rxcui" | "drugName" | "tier" | "estMonthlyCost" | "monthlySavings"> &
    Partial<Pick<Alternative, "status" | "priorAuth" | "stepTherapy" | "quantityLimit">>,
): Alternative {
  return {
    status: "covered",
    priorAuth: false,
    stepTherapy: false,
    quantityLimit: false,
    isEstimate: true,
    ...fields,
  };
}

function seedAlerts(): PatientAlert[] {
  return [
    {
      id: "al-evelyn-myrbetriq",
      patientId: "pt-007",
      patientName: "Evelyn Park",
      age: 83,
      language: "Korean",
      planName: "Humana Basic Rx",
      rxcui: "1300803",
      drugName: "24 HR mirabegron 50 MG Extended Release Oral Tablet [Myrbetriq]",
      displayName: "Myrbetriq",
      changeType: "tier_increase",
      oldTier: 3,
      newTier: 4,
      oldMonthlyCost: 110.49,
      newMonthlyCost: 150.27,
      monthlyIncrease: 39.78,
      percentIncrease: 36,
      effectiveDate: "2027-01-01",
      dataSource: "synthetic",
      bestAlternative: coveredAlternative({
        rxcui: "857560",
        drugName: "trospium chloride 20 MG Oral Tablet",
        tier: 1,
        estMonthlyCost: 9.32,
        monthlySavings: 140.95,
      }),
      status: "new",
      switchedTo: null,
    },
    {
      id: "al-harold-tradjenta",
      patientId: "pt-004",
      patientName: "Harold Bennett",
      age: 81,
      language: "English",
      planName: "Humana Basic Rx",
      rxcui: "1100706",
      drugName: "linagliptin 5 MG Oral Tablet [Tradjenta]",
      displayName: "Tradjenta",
      changeType: "tier_increase",
      oldTier: 3,
      newTier: 4,
      oldMonthlyCost: 126.14,
      newMonthlyCost: 171.56,
      monthlyIncrease: 45.42,
      percentIncrease: 36,
      effectiveDate: "2027-01-01",
      dataSource: "synthetic",
      bestAlternative: coveredAlternative({
        rxcui: "665044",
        drugName: "sitagliptin phosphate 50 MG Oral Tablet [Januvia]",
        status: "restricted",
        tier: 3,
        quantityLimit: true,
        estMonthlyCost: 29.31,
        monthlySavings: 142.25,
      }),
      status: "new",
      switchedTo: null,
    },
    {
      id: "al-james-toujeo",
      patientId: "pt-006",
      patientName: "James Carter",
      age: 77,
      language: "English",
      planName: "Humana Basic Rx",
      rxcui: "2002420",
      drugName: "3 ML insulin glargine 300 UNT/ML Pen Injector [Toujeo]",
      displayName: "Toujeo",
      changeType: "tier_increase",
      oldTier: 3,
      newTier: 4,
      oldMonthlyCost: 274.82,
      newMonthlyCost: 373.75,
      monthlyIncrease: 98.93,
      percentIncrease: 36,
      effectiveDate: "2027-01-01",
      dataSource: "synthetic",
      bestAlternative: null,
      status: "new",
      switchedTo: null,
    },
    {
      id: "al-patricia-gabapentin",
      patientId: "pt-014",
      patientName: "Patricia Johnson",
      age: 88,
      language: "English",
      planName: "Anthem Medicare Advantage 2 (PPO)",
      rxcui: "310431",
      drugName: "gabapentin 300 MG Oral Capsule",
      displayName: "gabapentin",
      changeType: "removed",
      oldTier: 2,
      newTier: null,
      oldMonthlyCost: 6.2,
      newMonthlyCost: 28.4,
      monthlyIncrease: 22.2,
      percentIncrease: 358,
      effectiveDate: "2027-01-01",
      dataSource: "cms",
      bestAlternative: null,
      status: "new",
      switchedTo: null,
    },
    {
      id: "al-hyunwoo-rosuvastatin",
      patientId: "pt-013",
      patientName: "Hyun-woo Kim",
      age: 76,
      language: "Korean",
      planName: "UHC Medicare Advantage GA-2 (PPO)",
      rxcui: "859751",
      drugName: "rosuvastatin calcium 20 MG Oral Tablet",
      displayName: "rosuvastatin",
      changeType: "new_prior_auth",
      oldTier: 2,
      newTier: 2,
      oldMonthlyCost: 11.46,
      newMonthlyCost: 11.46,
      monthlyIncrease: null,
      percentIncrease: null,
      effectiveDate: "2027-01-01",
      dataSource: "cms",
      bestAlternative: coveredAlternative({
        rxcui: "617311",
        drugName: "atorvastatin 40 MG Oral Tablet",
        tier: 1,
        estMonthlyCost: 3.12,
        monthlySavings: 8.34,
      }),
      status: "new",
      switchedTo: null,
    },
  ];
}

let alertStore = seedAlerts();
let messageStore = new Map<string, PatientMessage>();

function requireAlert(id: string): PatientAlert {
  const alert = alertStore.find((row) => row.id === id);
  if (!alert) throw new Error("Alert not found");
  return alert;
}

function buildDigest(): Digest {
  const open = alertStore.filter((row) => OPEN_ALERT_STATUSES.has(row.status));
  return {
    totalAtRisk: new Set(open.map((row) => row.patientId)).size,
    totalMonthlyIncrease: sumMoney(open.map((row) => row.monthlyIncrease)),
    totalMonthlySavingsIfSwitched: sumMoney(open.map((row) => row.bestAlternative?.monthlySavings)),
    alerts: alertStore.map(cloneAlert),
    generatedAt: new Date().toISOString(),
  };
}

function englishMessage(alert: PatientAlert): string {
  const first = alert.patientName.split(/\s+/)[0] ?? alert.patientName;
  const when = longDate(alert.effectiveDate);
  let change: string;
  switch (alert.changeType) {
    case "removed":
      change = `${alert.displayName} will be removed from your ${alert.planName} plan on ${when}.`;
      break;
    case "new_prior_auth":
      change = `${alert.displayName} will need prior authorization on your ${alert.planName} plan starting ${when}.`;
      break;
    case "new_step_therapy":
      change = `${alert.displayName} will require step therapy on your ${alert.planName} plan starting ${when}.`;
      break;
    case "new_quantity_limit":
      change = `${alert.displayName} will have a new quantity limit on your ${alert.planName} plan starting ${when}.`;
      break;
    default:
      change = `${alert.displayName} on your ${alert.planName} plan is estimated to cost ${estMoney(alert.newMonthlyCost)} a month starting ${when}, up from ${estMoney(alert.oldMonthlyCost)}.`;
  }
  const cost =
    alert.changeType === "tier_increase"
      ? ""
      : ` Estimated cost goes from ${estMoney(alert.oldMonthlyCost)} to ${estMoney(alert.newMonthlyCost)} a month.`;
  const alternative = alert.bestAlternative
    ? `We can switch you to ${displayDrugName(alert.bestAlternative.drugName)}, estimated at ${estMoney(alert.bestAlternative.estMonthlyCost)} a month.`
    : "We do not have a cheaper covered alternative. Call the office and we can talk about prior authorization or a manufacturer assistance program.";
  return `${first}, ${change}${cost} ${alternative}`;
}

function buildMessage(alert: PatientAlert): PatientMessage {
  const englishText = englishMessage(alert);
  if (alert.id === "al-evelyn-myrbetriq") {
    const when = koreanDate(alert.effectiveDate);
    const before = estMoney(alert.oldMonthlyCost);
    const after = estMoney(alert.newMonthlyCost);
    const alternative = estMoney(alert.bestAlternative?.estMonthlyCost);
    return {
      alertId: alert.id,
      language: "Korean",
      text: `에블린 님, ${when}부터 Humana Basic Rx의 Myrbetriq 약값이 오릅니다. 지금은 한 달에 ${before}이고, 변경 후에는 한 달에 ${after}입니다. trospium으로 바꾸시면 한 달에 ${alternative}로 예상됩니다. 궁금하신 점은 진료실로 전화해 주세요.`,
      englishText: `Evelyn, starting ${longDate(alert.effectiveDate)}, Myrbetriq on your Humana Basic Rx plan is estimated to rise from ${before} to ${after} a month. Switching to trospium is estimated at ${alternative} a month. Please call the office if you have questions.`,
      audioUrl: null,
    };
  }
  if (alert.id === "al-hyunwoo-rosuvastatin" && alert.bestAlternative) {
    return {
      alertId: alert.id,
      language: "Korean",
      text: `현우 님, ${koreanDate(alert.effectiveDate)}부터 ${alert.planName}에서 ${alert.displayName}은 사전 승인이 필요합니다. 예상 비용은 한 달에 ${estMoney(alert.newMonthlyCost)}입니다. ${displayDrugName(alert.bestAlternative.drugName)}으로 바꾸시면 한 달에 ${estMoney(alert.bestAlternative.estMonthlyCost)}로 예상됩니다. 궁금하신 점은 진료실로 전화해 주세요.`,
      englishText,
      audioUrl: null,
    };
  }
  return {
    alertId: alert.id,
    language: alert.language === "English" ? "English" : alert.language,
    text: englishText,
    englishText,
    audioUrl: null,
  };
}

/** GET /api/digest */
export async function getDigest(): Promise<Digest> {
  if (!USE_ALERT_MOCKS) return getJson<Digest>("/api/digest");
  return buildDigest();
}

/** POST /api/alerts/[id]/switch  body: { rxcui } */
export async function switchAlert(id: string, rxcui: string): Promise<PatientAlert> {
  if (!USE_ALERT_MOCKS) {
    return getJson<PatientAlert>(`/api/alerts/${encodeURIComponent(id)}/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rxcui }),
    });
  }
  const alert = requireAlert(id);
  alert.status = "switched";
  alert.switchedTo = rxcui;
  return cloneAlert(alert);
}

/** POST /api/alerts/[id]/dismiss */
export async function dismissAlert(id: string): Promise<PatientAlert> {
  if (!USE_ALERT_MOCKS) {
    return getJson<PatientAlert>(`/api/alerts/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  }
  const alert = requireAlert(id);
  alert.status = "dismissed";
  return cloneAlert(alert);
}

/** POST /api/alerts/[id]/message */
export async function createPatientMessage(id: string): Promise<PatientMessage> {
  if (!USE_ALERT_MOCKS) {
    return getJson<PatientMessage>(`/api/alerts/${encodeURIComponent(id)}/message`, { method: "POST" });
  }
  const existing = messageStore.get(id);
  if (existing) return { ...existing };
  const alert = requireAlert(id);
  const message = buildMessage(alert);
  messageStore.set(id, message);
  alert.status = "patient_notified";
  return { ...message };
}

/** POST /api/digest/email */
export async function emailDigest(): Promise<{ sent: true }> {
  if (!USE_ALERT_MOCKS) return getJson<{ sent: true }>("/api/digest/email", { method: "POST" });
  return { sent: true };
}

/** POST /api/demo/reset */
export async function resetDemo(): Promise<{ reset: true }> {
  if (!USE_ALERT_MOCKS) return getJson<{ reset: true }>("/api/demo/reset", { method: "POST" });
  alertStore = seedAlerts();
  messageStore = new Map();
  return { reset: true };
}
