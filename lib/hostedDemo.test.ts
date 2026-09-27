import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PatientAlert, CheckResponse } from "./contract";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>, user: "doctor-a", signedIn: true,
  rpc: vi.fn(), localDb: vi.fn(() => { throw new Error("Hosted workflow accessed DuckDB"); }),
}));
vi.mock("./supabase/server", () => ({ supabaseConfigured: () => true }));
vi.mock("./db", async importOriginal => ({ ...await importOriginal<typeof import("./db")>(), getDb: state.localDb }));
vi.mock("./auth", () => ({ requireUser: async () => {
  if (!state.signedIn) throw new Error("Sign in required");
  return { user: {id:state.user}, supabase: {
    from: (table:string) => {
      const filters: [string,unknown][]=[];
      const query = {
        select: () => query,
        eq: (key:string,value:unknown) => { filters.push([key,value]);return query; },
        then: (resolve:(value:unknown)=>unknown) => resolve({data:(state.tables[table]??[]).filter(row=>filters.every(([k,v])=>row[k]===v)),error:null}),
      };return query;
    }, rpc: state.rpc,
  }};
} }));

import { alertsForDoctor, countPatients, runCheck, selectAlternative, dismissAlert, resetAlertStatuses, searchPatients, searchPatientDrugs } from "./queries";
import { runAppPipeline } from "./pipeline/app-runner";
import { notifyPolicyChanges } from "./pipeline/policy-notification";

const alert:PatientAlert = {id:"alert-1",changeId:"change-1",changeType:"removed",patientId:"demo-pt-001",patientName:"Synthetic Patient",
  prescriptionId:"rx-1",rxcui:"123",drugName:"Original drug",contractId:"H0111",planId:"001",segmentId:"000",planName:"Wellcare",
  oldMonthlyCost:40,newMonthlyCost:null,bestAlternativeRxcui:"456",bestAlternativeName:"Covered alternative",bestAlternativeCost:10,
  status:"new",createdAt:"2026-09-27T00:00:00Z",fromVersion:"v1",toVersion:"v2-cms",detectedAt:"2026-09-27T00:00:00Z",oldTier:3,newTier:null};
const result:CheckResponse = {coverage:{rxcui:"123",drugName:"Original drug",status:"not_covered",tier:null,priorAuth:false,stepTherapy:false,quantityLimit:false,estMonthlyCost:null,isEstimate:true},
  alternatives:[{rxcui:"456",drugName:"Covered alternative",status:"covered",tier:1,priorAuth:false,stepTherapy:false,quantityLimit:false,estMonthlyCost:10,isEstimate:true,monthlySavings:0}]};

beforeEach(()=>{
  vi.unstubAllEnvs();state.signedIn=true;state.user="doctor-a";state.localDb.mockClear();state.rpc.mockReset();
  state.tables={demo_patients:[{id:alert.patientId,doctor_id:"doc-001",full_name:alert.patientName,plan:{contractId:"H0111",planId:"001",segmentId:"000",planName:"Wellcare"},prescriptions:[{id:"rx-1",rxcui:"123",drugName:"Original drug"}]}],
    demo_patient_alerts:[{id:alert.id,doctor_id:"doc-001",patient_id:alert.patientId,check_id:"check-1",payload:alert}],
    demo_coverage_checks:[{id:"check-1",contract_id:"H0111",plan_id:"001",segment_id:"000",rxcui:"123",plan_name:"Wellcare",result,ndcs:[]}],
    demo_changes:[{id:"change-1",payload:{id:"change-1"}}],demo_doctors:[],demo_patient_reviews:[]};
  state.rpc.mockImplementation(async (name:string,args:{p_alert_id?:string;p_rxcui?:string})=>{
    const rows=state.tables.demo_patient_reviews;
    if(name==="reset_demo_reviews") { state.tables.demo_patient_reviews=[{user_id:state.user,alert_id:alert.id,status:"new",selected_rxcui:null,saved_at:null}]; }
    else {
      let row=rows.find(r=>r.user_id===state.user&&r.alert_id===args.p_alert_id);
      if(!row) {row={user_id:state.user,alert_id:args.p_alert_id};rows.push(row);}
      if(name==="select_demo_alternative") Object.assign(row,{status:"seen",selected_rxcui:args.p_rxcui,saved_at:"2026-09-27T01:00:00Z"});
      if(name==="dismiss_demo_alert") row.status="dismissed";
    }
    return {data:null,error:null};
  });
});

describe("hosted patient workflow",()=>{
  it("reads the panel, patient search, drugs and verified alternatives without DuckDB",async()=>{
    expect(await countPatients(undefined,"doc-001")).toBe(1);
    expect(await alertsForDoctor("doc-001")).toHaveLength(1);
    expect(await alertsForDoctor("another-doctor")).toEqual([]);
    expect(await searchPatients("synthetic")).toHaveLength(1);
    expect(await searchPatientDrugs(alert.patientId,"original")).toEqual([{rxcui:"123",drugName:"Original drug"}]);
    expect(await runCheck({patientId:alert.patientId,rxcui:"123"})).toEqual(result);
    expect(state.localDb).not.toHaveBeenCalled();
  });
  it("saves a verified choice, retains it on dismissal and resets it",async()=>{
    const selected=await selectAlternative(alert.id,"456");
    expect(selected).toMatchObject({status:"seen",selectedAlternative:{rxcui:"456",estMonthlyCost:10}});
    expect(await dismissAlert(alert.id)).toMatchObject({status:"dismissed",selectedAlternative:{rxcui:"456"}});
    await resetAlertStatuses();
    expect((await alertsForDoctor("doc-001"))[0]).toMatchObject({status:"new",selectedAlternative:null});
    expect(state.localDb).not.toHaveBeenCalled();
  });
  it("rejects an unverified alternative before writing",async()=>{
    await expect(selectAlternative(alert.id,"bogus")).rejects.toMatchObject({status:422});
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("keeps each doctor's review state separate",async()=>{
    await selectAlternative(alert.id,"456");state.user="doctor-b";
    expect((await alertsForDoctor("doc-001"))[0]).toMatchObject({status:"new",selectedAlternative:null});
  });
  it("requires sign-in and fails closed if hosted fixtures are missing",async()=>{
    state.signedIn=false;await expect(alertsForDoctor("doc-001")).rejects.toThrow("Sign in required");
    state.signedIn=true;state.tables.demo_patients=[];
    await expect(alertsForDoctor("doc-001")).rejects.toThrow("has not been seeded");
    expect(state.localDb).not.toHaveBeenCalled();
  });
  it("rejects checks outside the seeded plan/drug snapshot",async()=>{
    await expect(runCheck({patientId:alert.patientId,rxcui:"not-seeded"})).rejects.toMatchObject({status:404});
  });
  it("replays and previews using hosted counts without sending or opening DuckDB",async()=>{
    expect(await runAppPipeline()).toMatchObject({changes:1,alerts:1});
    const send=vi.fn();
    const preview=await notifyPolicyChanges(true,undefined,{APP_URL:"https://example.test"},send);
    expect(preview).toMatchObject({patients:1,changes:1,notification:{mode:"preview"}});
    expect(send).not.toHaveBeenCalled();expect(state.localDb).not.toHaveBeenCalled();
  });
});
