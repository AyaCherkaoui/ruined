import { displayDrugName } from "../../components/format";
import type { Alternative, CheckResponse, Patient, Plan } from "@/lib/contract";

/**
 * Search routes are still being built. While this is true, patient search, drug search,
 * and the upcoming-change list return local fixtures. Coverage checks always hit POST /api/check.
 */
export const USE_MOCKS = true;

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
