"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { resetDemo } from "@/app/_lib/api";
import type { Doctor } from "@/lib/contract";
import { initials } from "@/lib/medishift-view";

export function SiteChrome({ doctor, children }: { doctor: Doctor | null; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [signOutNote, setSignOutNote] = useState<string | null>(null);
  const doctorName = doctor?.fullName ?? "No doctor on file";

  async function onReset() {
    setResetting(true);
    setResetError(null);
    try {
      await resetDemo();
      router.refresh();
      router.push("/");
    } catch (error: unknown) {
      setResetError(error instanceof Error ? error.message : "Could not reset the demo");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-[#e6e1f2] bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-[#5c4dff] text-sm font-semibold text-white">
              M
            </span>
            <span>
              <span className="block text-base font-semibold leading-5 text-[#1b1733]">MediShift</span>
              <span className="block text-xs text-[#6d6788]">Formulary change console</span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-semibold text-[#1b1733]">{doctorName}</p>
              {doctor ? <p className="text-xs text-[#8a84a3]">{doctor.id.toUpperCase()}</p> : null}
            </div>
            <span className="flex size-10 items-center justify-center rounded-full bg-[#f0a202] text-xs font-semibold text-[#2a2110]">
              {doctor ? initials(doctor.fullName) : "—"}
            </span>
            <button
              type="button"
              onClick={() => setSignOutNote("Sign out is not available. Authentication is not connected.")}
              className="hidden text-sm font-medium text-[#5c5678] hover:text-[#1b1733] sm:inline"
            >
              Sign out
            </button>
          </div>
        </div>
        {signOutNote ? (
          <p className="mx-auto w-full max-w-6xl px-4 pb-3 text-right text-xs text-[#6d6788] sm:px-6">{signOutNote}</p>
        ) : null}
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-[#e6e1f2]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 text-xs text-[#6d6788] sm:px-6">
          <Link href="/check" className={pathname === "/check" ? "font-semibold text-[#1b1733]" : "hover:text-[#1b1733]"}>
            Check a prescription
          </Link>
          <Link href="/dashboard" className={pathname === "/dashboard" ? "font-semibold text-[#1b1733]" : "hover:text-[#1b1733]"}>
            Cost chart
          </Link>
          <Link
            href="/coverage-alerts"
            className={pathname === "/coverage-alerts" ? "font-semibold text-[#1b1733]" : "hover:text-[#1b1733]"}
          >
            Coverage Watchdog
          </Link>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-[#1b1733] disabled:opacity-50"
            disabled={resetting}
            onClick={() => void onReset()}
          >
            {resetting ? "Resetting…" : "Reset demo"}
          </button>
          {resetError ? <p className="text-red-700">{resetError}</p> : null}
        </div>
      </footer>
    </div>
  );
}
