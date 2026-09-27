"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { resetDemo } from "@/app/_lib/api";

const LINKS = [
  { href: "/", label: "Alerts" },
  { href: "/check", label: "Check a prescription" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/coverage-alerts", label: "Coverage Watchdog" },
];

export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

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
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <p className="text-sm font-medium tracking-wide text-teal-800">Medicare Part D</p>
          <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center text-sm font-medium underline-offset-8 hover:text-neutral-950 ${active ? "text-neutral-950 underline decoration-teal-700 decoration-2" : "text-neutral-600"}`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-neutral-200">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <button
            type="button"
            className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 disabled:opacity-50"
            disabled={resetting}
            onClick={() => void onReset()}
          >
            {resetting ? "Resetting…" : "Reset demo"}
          </button>
          {resetError ? <p className="text-xs text-red-700">{resetError}</p> : null}
        </div>
      </footer>
    </div>
  );
}
