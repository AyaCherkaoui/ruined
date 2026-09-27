"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export interface SessionSelection {
  rxcui: string;
  drugName: string;
  estMonthlyCost: number | null;
  monthlySavings: number;
  at: string;
}

export interface SessionNotice {
  ok: boolean;
  error: string | null;
  message: string;
  at: string;
  deliveryStatus: string | null;
  messageId: string | null;
}

interface SessionState {
  selections: Record<string, SessionSelection>;
  notices: Record<string, SessionNotice>;
}

const KEY = "medishift-session-v1";
const EVENT = "medishift-session";
const EMPTY: SessionState = { selections: {}, notices: {} };

let cachedRaw: string | null = null;
let cached: SessionState = EMPTY;

function read(): SessionState {
  if (typeof window === "undefined") return EMPTY;
  const raw = window.sessionStorage.getItem(KEY);
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  if (!raw) {
    cached = EMPTY;
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    cached = {
      selections: parsed.selections ?? {},
      notices: parsed.notices ?? {},
    };
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function write(next: SessionState) {
  window.sessionStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener(EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function useMedishiftSession(): SessionState {
  const session = useSyncExternalStore(subscribe, read, () => EMPTY);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return ready ? session : EMPTY;
}

export function saveSelection(alertId: string, selection: SessionSelection) {
  const current = read();
  write({ ...current, selections: { ...current.selections, [alertId]: selection } });
}

export function saveNotice(alertId: string, notice: SessionNotice) {
  const current = read();
  write({ ...current, notices: { ...current.notices, [alertId]: notice } });
}
