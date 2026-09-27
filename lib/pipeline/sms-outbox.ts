import type { Db } from "../db";
import type { CoverageChangeFact, DoctorImpact } from "./aggregate-contract";
import { stableId } from "./aggregate-store";
import { readChanges } from "./compare-snapshots";
import { matchPrescriberImpacts } from "./prescriber-impact";

export type NormalizedReply = "stop" | "start" | "acknowledge" | "unknown";
export function normalizeReply(value: string): NormalizedReply {
  const text = value.trim().toUpperCase();
  if (["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(text)) return "stop";
  if (["START", "UNSTOP"].includes(text)) return "start";
  if (["ACK", "ACKNOWLEDGE", "YES"].includes(text)) return "acknowledge";
  return "unknown";
}

export function formatAggregateSms(impact: DoctorImpact, change: CoverageChangeFact) {
  if (impact.changeId !== change.id) throw new Error("Impact/change mismatch");
  if (impact.estimate.metric !== "total_claims") throw new Error("SMS adapter requires total_claims metric");
  const count = impact.estimate.value === null ? (impact.suppressed ? "suppressed" : "unknown") : String(impact.estimate.value);
  return `DEMO PREVIEW | Eliquis coverage: ${change.changeType.replaceAll("_", " ")}. ${impact.sourceYear} annual apixaban claims: ${count}, across all plans/strengths; not an affected-patient count. Demo plan acceptance. Change: ${change.provenance}; volume: ${impact.qualityFlags.includes("simulated_source") ? "simulated" : "CMS aggregate"}.`;
}

export interface OutboxEntry {
  id: string; impactId: string; recipientRef: string; message: string;
  status: "pending" | "previewed" | "failed" | "cancelled"; attempts: number;
}
export interface PreviewAdapter {
  mode: "console-only";
  preview: (entry: Pick<OutboxEntry, "id" | "recipientRef" | "message">) => Promise<void>;
}
export function consolePreviewAdapter(log: (line: string) => void = console.log): PreviewAdapter {
  return { mode: "console-only", preview: async (entry) => { log(JSON.stringify({ mode: "dry-run", outboxId: entry.id, recipient: "[redacted]", message: entry.message })); } };
}

export async function readOutbox(db: Db): Promise<OutboxEntry[]> {
  return (await db.query<{ payload: string }>("SELECT payload FROM sms_outbox ORDER BY id")).map((r) => JSON.parse(r.payload));
}
async function save(db: Db, entry: OutboxEntry) {
  await db.run("UPDATE sms_outbox SET status=$1, attempts=$2, payload=$3 WHERE id=$4", [entry.status, entry.attempts, JSON.stringify(entry), entry.id]);
}

export async function enqueueSmsPreviews(db: Db, year: number) {
  const impacts = await matchPrescriberImpacts(db, year);
  const changes = new Map((await readChanges(db)).map((c) => [c.id, c]));
  for (const impact of impacts) {
    const id = stableId("sms-preview-v1", impact.id);
    // No phone numbers, credentials, or raw NPI enter the outbox or its logs.
    const entry: OutboxEntry = { id, impactId: impact.id, recipientRef: stableId("demo-recipient", impact.npi), message: formatAggregateSms(impact, changes.get(impact.changeId)!), status: "pending", attempts: 0 };
    await db.run("INSERT INTO sms_outbox VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [id, impact.id, entry.status, 0, JSON.stringify(entry)]);
  }
  return readOutbox(db);
}

/** This interface cannot deliver an SMS. Failed console writes are retried on the next drain. */
export async function drainSmsPreviews(db: Db, adapter: PreviewAdapter = consolePreviewAdapter(), maxAttempts = 3) {
  if (adapter.mode !== "console-only") throw new Error("Live delivery is not implemented");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid retry limit");
  const changes = new Map((await readChanges(db)).map((c) => [c.id, c]));
  const impacts = new Map((await db.query<{ id: string; change_id: string }>("SELECT id, change_id FROM doctor_impacts")).map((i) => [i.id, i.change_id]));
  for (const entry of await readOutbox(db)) {
    if (entry.status === "previewed" || entry.status === "cancelled") continue;
    const change = changes.get(impacts.get(entry.impactId) ?? "");
    if (!change || change.resolvedByChangeId || change.direction !== "worsened") { entry.status = "cancelled"; await save(db, entry); continue; }
    if (entry.attempts >= maxAttempts) continue;
    // Persist attempt before preview, so a crash cannot reset the retry budget.
    entry.attempts++;
    entry.status = "failed";
    await save(db, entry);
    try { await adapter.preview({ id: entry.id, recipientRef: entry.recipientRef, message: entry.message }); entry.status = "previewed"; }
    catch { /* Never store an adapter exception: it may contain addresses or secrets. */ }
    await save(db, entry);
  }
  return readOutbox(db);
}
