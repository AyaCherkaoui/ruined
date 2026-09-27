"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-full bg-white">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10 sm:px-6">
        <h1 className="max-w-[16ch] text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-950">
          Unable to load this page.
        </h1>
        <p className="text-lg text-neutral-700">The request failed. Nothing on this screen was filled in with placeholder patients.</p>
        <Button className="h-12 w-fit px-5 text-base" onClick={() => retry()}>
          Try again
        </Button>
      </main>
    </div>
  );
}
