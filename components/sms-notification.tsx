"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SmsResult } from "@/lib/sms";

export function SmsNotification({ alertId }: { alertId: string }) {
  const inputId = useId();
  const [result, setResult] = useState<SmsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function notify(preview: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (preview) {
        const config = await fetch("/api/notify", { cache: "no-store" });
        if (!config.ok) throw new Error("Could not load messaging settings. Try again.");
        setLive((await config.json()).mode === "live");
      }
      const response = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(!preview ? { Authorization: `Bearer ${accessKey}` } : {}) },
        body: JSON.stringify({ changeId: alertId, preview }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not process this text. Try again.");
      setResult(data);
      if (!preview) setAccessKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not process this text. Try again.");
    } finally { setBusy(false); }
  }

  const locked = result?.status === "accepted" || result?.status === "unknown";
  return (
    <section className="flex flex-col gap-3 border-t border-neutral-200 pt-4" aria-label="Text notification" aria-busy={busy}>
      <p className="text-sm text-neutral-600">Text a reminder to review this alert. Messages omit drug names, patient details, and affected counts.</p>
      <Button variant="outline" className="h-11 w-fit" disabled={busy || locked} onClick={() => void notify(true)}>
        {busy ? "Processing…" : "Preview text"}
      </Button>
      {result ? (
        <div className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-600">Message</p>
          <p className="break-words text-sm leading-6 text-neutral-900">{result.body}</p>
          <p role="status" className="text-sm text-neutral-700">
            {result.status === "accepted" ? "Accepted by the messaging provider. Delivery is not yet confirmed."
              : result.error ?? (live ? "Preview only. No text has been sent." : "Preview mode. Live messaging is not configured; no text was sent.")}
          </p>
          {live && !locked ? (
            <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void notify(false); }}>
              <label htmlFor={inputId} className="text-sm font-medium">Messaging access key</label>
              <input id={inputId} type="password" autoComplete="current-password" required value={accessKey}
                onChange={(event) => setAccessKey(event.target.value)} className="h-11 min-w-0 rounded-lg border border-neutral-300 bg-white px-3 focus-visible:outline-2 focus-visible:outline-teal-700" />
              <Button type="submit" className="h-11 w-fit" disabled={busy || !accessKey.trim()}>Send text to configured recipient</Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
