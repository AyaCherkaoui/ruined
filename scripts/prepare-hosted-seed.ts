import fs from "node:fs/promises";

/** Produces reviewable, transactional SQL for SQL Editor/MCP; no secret key is needed. */
async function main() {
  const data=JSON.parse(await fs.readFile("data/raw/hosted-demo/export.json","utf8"));
  const sources=JSON.parse(await fs.readFile("data/raw/hosted-demo/verified-sources.json","utf8"));
  if(sources.length!==2 || data.patients.length!==136) throw new Error("Export or verified sources missing");
  for(const source of sources) {
    const local=data.sources.find((s:{id:string})=>s.id===source.id);
    if(local?.file_hash!==source.sha256 || local?.source!==source.source_url) throw new Error("Source verification does not match export");
    if(JSON.stringify(data.evidence.filter((e:{version:string})=>e.version===source.id))!==JSON.stringify(source.evidence.formularyComparisons)) {
      throw new Error("Export evidence changed since verification");
    }
  }
  const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
  const insert=(table:string,rows:Record<string,unknown>[])=>{
    if(!rows.length) throw new Error(`Empty ${table}`);
    const columns=Object.keys(rows[0]);
    return `INSERT INTO public.${table} (${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_populate_recordset(null::public.${table},${quote(JSON.stringify(rows))}::jsonb) ON CONFLICT (id) DO UPDATE SET ${columns.filter(c=>c!=="id").map(c=>`${c}=excluded.${c}`).join(",")};`;
  };
  const statements=["BEGIN;",
    insert("demo_source_releases",sources),insert("demo_doctors",data.doctors),insert("demo_patients",data.patients),
    insert("demo_coverage_checks",data.checks),insert("demo_changes",data.changes),insert("demo_patient_alerts",data.alerts),
    insert("coverage_alerts",data.coverageAlerts),
    // Preserve the existing local demo account's choices and send deduplication history.
    // Never overwrite a decision or receipt that already exists remotely.
    `INSERT INTO public.demo_patient_reviews(user_id,alert_id,status,selected_rxcui,saved_at)
      SELECT u.id,r.alert_id,r.status,r.selected_rxcui,r.saved_at FROM auth.users u,
      jsonb_to_recordset(${quote(JSON.stringify(data.initialReviews??[]))}::jsonb) AS r(alert_id text,status text,selected_rxcui text,saved_at timestamptz)
      WHERE u.email='doctor@test.com' ON CONFLICT(user_id,alert_id) DO NOTHING;`,
    `INSERT INTO public.demo_notification_receipts(user_id,id,result,created_at)
      SELECT u.id,r.id,r.result,r.created_at FROM auth.users u,
      jsonb_to_recordset(${quote(JSON.stringify(data.notificationReceipts??[]))}::jsonb) AS r(id text,result jsonb,created_at timestamptz)
      WHERE u.email='doctor@test.com' ON CONFLICT(user_id,id) DO NOTHING;`,
    // Only retire the two known simulated placeholders; never clear unrelated alerts or user choices.
    "DELETE FROM public.coverage_alerts WHERE is_demo AND id IN ('demo-eliquis-s5884-135-prior-auth-added','demo-eliquis-h5216-073-tier-increase');",
    "COMMIT;"
  ];
  await fs.writeFile("data/raw/hosted-demo/seed.sql",statements.join("\n"));
  console.log("Prepared verified hosted seed: 136 synthetic patients, 136 alerts, 7 checks, 5 changes, 7 real CMS coverage alerts.");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
