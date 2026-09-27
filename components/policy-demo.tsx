"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SmsResult } from "@/lib/sms";

type Result = { patients: number; changes: number; configured: boolean; setupIssue?: string | null; receiptId?: string; duplicate?: boolean; notification: SmsResult };

function statusText(result: Result): string {
  const n = result.notification;
  if (n.status === "preview") return "Preview only. No message sent.";
  if (n.status === "accepted") return "WhatsApp sent to the demo recipient.";
  if (n.status === "failed") return n.error ?? "The message could not be sent.";
  return n.error ?? "Send status is uncertain. Check Twilio before trying again.";
}

export function PolicyDemo() {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"alert" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(action: "alert" | "preview") {
    setBusy(action); setError(null);
    try {
      const response = await fetch("/api/demo/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The demo could not run.");
      setResult(data);
      router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "The demo could not run."); }
    finally { setBusy(null); }
  }
  return <section className="rounded-3xl bg-white p-5 ring-1 ring-[#e6e1f2]" aria-label="Policy change demo" aria-busy={Boolean(busy)}>
    <h2 className="font-semibold text-[#1b1733]">Policy change → WhatsApp demo</h2>
    <p className="mt-2 text-sm text-[#5c5678]">Synthetic patients · Wellcare and CareSource · Farxiga and exenatide. Replays the recorded CMS insurance changes, matches affected prescriptions, and alerts the doctor on WhatsApp.</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button disabled={Boolean(busy)} onClick={() => void run("alert")} className="min-h-11 rounded-full bg-[#5c4dff] px-5 text-sm font-semibold text-white disabled:opacity-50">{busy === "alert" ? "Sending…" : "Simulate insurance change & send WhatsApp"}</button>
      <button disabled={Boolean(busy)} onClick={() => void run("preview")} className="min-h-11 rounded-full bg-[#ece7ff] px-5 text-sm font-semibold text-[#4b3fd4] disabled:opacity-50">{busy === "preview" ? "Processing…" : "Preview only"}</button>
    </div>
    {result ? <div className="mt-4 space-y-3 text-sm">
      <p>{result.patients} patients awaiting review · {result.changes} policy changes</p>
      <p className="break-words rounded-xl bg-[#f7f5fc] p-3">{result.notification.body}</p>
      {result.setupIssue ? <p role="status">{result.setupIssue}</p> : null}
      <p role="status">{statusText(result)}</p>
    </div> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
  </section>;
}
