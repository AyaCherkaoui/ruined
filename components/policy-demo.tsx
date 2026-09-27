"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SmsResult } from "@/lib/sms";

type Result = { patients: number; changes: number; configured: boolean; setupIssue?: string | null; receiptId?: string; duplicate?: boolean; notification: SmsResult };
export function PolicyDemo() {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function run(action: "preview" | "send" | "status") {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/demo/policy", { method: "POST", headers: { "Content-Type": "application/json", ...(action !== "preview" ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ action, receiptId: result?.receiptId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The demo could not run.");
      setResult(previous => ({ ...previous, ...data }));
      if (action !== "preview") setKey("");
      router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "The demo could not run."); }
    finally { setBusy(false); }
  }
  const locked = result?.notification.status === "accepted" || result?.notification.status === "unknown";
  return <section className="rounded-3xl bg-white p-5 ring-1 ring-[#e6e1f2]" aria-label="Policy change demo" aria-busy={busy}>
    <h2 className="font-semibold text-[#1b1733]">Policy change → WhatsApp demo</h2>
    <p className="mt-2 text-sm text-[#5c5678]">Synthetic patients · Wellcare and CareSource · Farxiga and exenatide. Replay the recorded CMS changes, match prescriptions, then preview a reminder to the configured demo recipient.</p>
    <button disabled={busy} onClick={() => void run("preview")} className="mt-3 min-h-11 rounded-full bg-[#ece7ff] px-5 text-sm font-semibold text-[#4b3fd4] disabled:opacity-50">{busy ? "Processing…" : "Replay policy changes & preview WhatsApp"}</button>
    {result ? <div className="mt-4 space-y-3 text-sm">
      <p>{result.patients} patients awaiting review · {result.changes} policy changes</p>
      <p className="break-words rounded-xl bg-[#f7f5fc] p-3">{result.notification.body}</p>
      {result.setupIssue ? <p role="status">{result.setupIssue}</p> : null}
      <p role="status">{result.notification.deliveryStatus ? `Provider status: ${result.notification.deliveryStatus}. ${["delivered", "read"].includes(result.notification.deliveryStatus) ? "Delivery confirmed by provider." : "Delivery is not confirmed."}` : result.notification.error ?? "Preview only. No message sent."}{result.duplicate ? " Existing receipt reused; no duplicate sent." : ""}</p>
      {result.notification.error && result.notification.deliveryStatus ? <p role="alert">{result.notification.error}</p> : null}
      {result.configured ? <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">Messaging access key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} className="h-11 rounded-lg border px-3" /></label>
        <button disabled={busy || !key || locked || !result.patients || Boolean(result.setupIssue)} onClick={() => void run("send")} className="min-h-11 rounded-full bg-[#5c4dff] px-5 text-white disabled:opacity-50">Send WhatsApp to demo recipient</button>
        {result.receiptId ? <button disabled={busy || !key} onClick={() => void run("status")} className="min-h-11 px-3 underline disabled:opacity-50">Check delivery</button> : null}
      </div> : <p>Live WhatsApp is not configured. Preview works without credentials.</p>}
    </div> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
  </section>;
}
