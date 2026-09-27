import { cache } from "react";
import { requireUser } from "./auth";
import { supabaseConfigured } from "./supabase/server";
import { ApiError } from "./http";
import type { CheckResponse, CoverageChange, Doctor, PatientAlert, PatientSummary, PatientAlertStatus } from "./contract";
import type { CheckRequest } from "./queries";
import type { SmsResult } from "./sms";
import { humanaCheck } from "./insurer-check";

export function hostedDemoEnabled(): boolean {
  return process.env.PATIENT_DATA_SOURCE !== "local" && supabaseConfigured();
}

interface PatientRow {
  id: string; full_name: string; doctor_id: string; plan: PatientSummary["plan"];
  prescriptions: { id: string; rxcui: string; drugName: string }[];
}
interface CheckRow {
  id: string; plan_name: string; contract_id: string; plan_id: string; segment_id: string;
  rxcui: string; result: CheckResponse; ndcs: string[];
}
interface AlertRow { id: string; doctor_id: string; patient_id: string; check_id: string; payload: PatientAlert }
interface ReviewRow { alert_id: string; status: PatientAlertStatus; selected_rxcui: string | null; saved_at: string | null }

function check(error: {message: string; code?: string} | null) {
  if (error) throw new ApiError(503, `Hosted demo unavailable: ${error.message}`);
}

const session = cache(async () => {
  const value = await requireUser();
  if (!value) throw new ApiError(503, "Configure Supabase for the hosted patient demo.");
  return value;
});

// React cache is request-scoped: never share signed-in users' data across requests.
const fixtures = cache(async () => {
  const {supabase} = await session();
  const results = await Promise.all([
    supabase.from("demo_patients").select("*"),
    supabase.from("demo_patient_alerts").select("*"),
    supabase.from("demo_coverage_checks").select("*"),
    supabase.from("demo_changes").select("*"),
    supabase.from("demo_doctors").select("*"),
  ]);
  for (const result of results) check(result.error);
  if (!results[0].data?.length) throw new ApiError(503, "The hosted patient demo has not been seeded.");
  return {patients:results[0].data as PatientRow[], alerts:results[1].data as AlertRow[],
    checks:results[2].data as CheckRow[], changes:results[3].data as {id:string;payload:CoverageChange}[],
    doctors:results[4].data as {id:string;full_name:string;phone:string|null}[]};
});

export function applyHostedReview(alert: PatientAlert, review: ReviewRow | undefined, result: CheckResponse): PatientAlert {
  const choice = result.alternatives.find(a => a.rxcui === review?.selected_rxcui);
  return {...alert, status:review?.status ?? alert.status, selectedAlternative: choice && review?.saved_at
    ? {rxcui:choice.rxcui,drugName:choice.drugName,estMonthlyCost:choice.estMonthlyCost,savedAt:review.saved_at} : null};
}

export async function hostedAlerts(doctorId?: string): Promise<PatientAlert[]> {
  const [data,{supabase,user}] = await Promise.all([fixtures(),session()]);
  const {data:reviews,error} = await supabase.from("demo_patient_reviews").select("*").eq("user_id",user.id);
  check(error);
  const byId = new Map((reviews as ReviewRow[] ?? []).map(r=>[r.alert_id,r]));
  return data.alerts.filter(a=>!doctorId || a.doctor_id===doctorId).map(a=> {
    const result = data.checks.find(c=>c.id===a.check_id)?.result;
    if (!result) throw new ApiError(503,"Hosted alert is missing its verified coverage snapshot.");
    return applyHostedReview(a.payload,byId.get(a.id),result);
  }).sort((a,b)=>a.patientName.localeCompare(b.patientName)||a.id.localeCompare(b.id));
}
export async function hostedAlert(id:string) { return (await hostedAlerts()).find(a=>a.id===id) ?? null; }
export async function hostedDoctor(id:string):Promise<Doctor|null> {
  const row=(await fixtures()).doctors.find(d=>d.id===id);
  return row?{id:row.id,fullName:row.full_name,phone:row.phone}:null;
}
export async function hostedPatient(id:string) {
  const row=(await fixtures()).patients.find(p=>p.id===id);
  return row?{id:row.id,fullName:row.full_name}:null;
}
export async function hostedCount(doctorId?:string) { return (await fixtures()).patients.filter(p=>!doctorId||p.doctor_id===doctorId).length; }
export async function hostedSearchPatients(query:string):Promise<PatientSummary[]> {
  const q=query.trim().toLowerCase();
  return (await fixtures()).patients.filter(p=>p.full_name.toLowerCase().includes(q)||p.id.toLowerCase().includes(q))
    .sort((a,b)=>a.full_name.localeCompare(b.full_name)).slice(0,8).map(p=>({id:p.id,fullName:p.full_name,plan:p.plan}));
}
export async function hostedSearchDrugs(patientId:string,query:string) {
  if (!patientId.trim()) throw new ApiError(400,"patientId is required");
  const patient=(await fixtures()).patients.find(p=>p.id===patientId);
  if(!patient) throw new ApiError(404,`Patient ${patientId} not found`);
  const q=query.trim().toLowerCase();
  return patient.prescriptions.filter(p=>p.drugName.toLowerCase().includes(q)||p.rxcui===q)
    .map(p=>({rxcui:p.rxcui,drugName:p.drugName}));
}
async function checkFor(body:CheckRequest):Promise<CheckRow> {
  const data=await fixtures();
  const patient=body.patientId?data.patients.find(p=>p.id===body.patientId):null;
  if(body.patientId&&!patient) throw new ApiError(404,`Patient ${body.patientId} not found`);
  const plan=patient?.plan??body;
  if(!plan.contractId||!plan.planId) throw new ApiError(400,"Provide patientId, or contractId and planId");
  const rxcui=body.rxcui?.trim();
  const name=body.drugName?.trim().toLowerCase();
  if(!rxcui&&!name) throw new ApiError(400,"Provide rxcui or drugName");
  const result=data.checks.find(c=>c.contract_id===plan.contractId&&c.plan_id===plan.planId&&c.segment_id===(plan.segmentId||"000")
    && (rxcui?c.rxcui===rxcui:c.result.coverage.drugName.toLowerCase()===name));
  if(!result) throw new ApiError(404,"This drug and plan are not in the verified hosted demo snapshot.");
  return result;
}
export async function hostedCheck(body:CheckRequest):Promise<CheckResponse> { return (await checkFor(body)).result; }
export async function hostedInsurerCheck(body:CheckRequest,opts:{fetch?:typeof fetch}={}) {
  const c=await checkFor(body);
  if(!/\bhumana\b/i.test(c.plan_name)) return {status:"unsupported" as const,planName:c.plan_name};
  return humanaCheck({contractId:c.contract_id,planId:c.plan_id,segmentId:c.segment_id},c.ndcs,opts);
}
export async function hostedSelect(id:string,rxcui:string):Promise<PatientAlert> {
  const existing=await hostedAlert(id);
  if(!existing) throw new ApiError(404,`Alert ${id} not found`);
  const result=await hostedCheck(existing);
  if(!result.alternatives.some(a=>a.rxcui===rxcui)) throw new ApiError(422,"Choose an alternative currently offered for this patient's plan.");
  const {supabase}=await session();
  const {error}=await supabase.rpc("select_demo_alternative",{p_alert_id:id,p_rxcui:rxcui}); check(error);
  return (await hostedAlert(id))!;
}
export async function hostedDismiss(id:string):Promise<PatientAlert> {
  if(!await hostedAlert(id)) throw new ApiError(404,`Alert ${id} not found`);
  const {supabase}=await session();
  const {error}=await supabase.rpc("dismiss_demo_alert",{p_alert_id:id});
  check(error); return (await hostedAlert(id))!;
}
export async function hostedReset():Promise<{reset:true}> {
  const {supabase}=await session(); const {error}=await supabase.rpc("reset_demo_reviews");check(error);return {reset:true};
}
export async function hostedChanges() { return (await fixtures()).changes.map(c=>c.payload); }
export async function hostedReplay() {
  const alerts=await hostedAlerts("doc-001");
  const changes=await hostedChanges();
  if(!alerts.length||!changes.length) throw new ApiError(503,"Hosted demo is missing verified changes.");
  // Replays the exported, source-verified match results. It is not a new insurer scrape.
  return {fromVersion:"v1",toVersion:"v2-cms",rxcuis:[...new Set(alerts.map(a=>a.rxcui))].sort(),
    changeIds:[...new Set(alerts.map(a=>a.changeId))].sort(),alertIds:alerts.map(a=>a.id).sort(),
    changes:new Set(alerts.map(a=>a.changeId)).size,alerts:alerts.length};
}
export async function hostedReserveReceipt(id:string,result:SmsResult):Promise<SmsResult|null> {
  const {supabase}=await session();
  const response=await supabase.rpc("reserve_demo_notification",{p_id:id,p_result:result});check(response.error);
  return response.data as SmsResult|null;
}
export async function hostedReadReceipt(id:string):Promise<SmsResult|null> {
  const {supabase,user}=await session();
  const {data,error}=await supabase.from("demo_notification_receipts").select("result").eq("user_id",user.id).eq("id",id).maybeSingle();
  check(error);return data?.result as SmsResult??null;
}
export async function hostedWriteReceipt(id:string,result:SmsResult|null) {
  const {supabase,user}=await session();
  const query=result?supabase.from("demo_notification_receipts").update({result}):supabase.from("demo_notification_receipts").delete();
  const {error}=await query.eq("user_id",user.id).eq("id",id);check(error);
}
