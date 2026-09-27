import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { safeNextPath } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/supabase/server";
import { login } from "./actions";

export const dynamic = "force-dynamic";

const INPUT =
  "h-12 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-950 outline-none placeholder:text-neutral-500 focus-visible:border-teal-700 focus-visible:ring-3 focus-visible:ring-teal-700/30";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const error = typeof params.error === "string" ? params.error : null;
  if (!supabaseConfigured()) redirect(next);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-950">Sign in</h1>
        <p className="text-sm text-neutral-600">Doctor accounts only. Ask your team for access.</p>
      </header>
      <Card>
        <CardContent>
          <form action={login} className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-900">
              Email
              <input name="email" type="email" autoComplete="email" required className={INPUT} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-900">
              Password
              <input name="password" type="password" autoComplete="current-password" required className={INPUT} />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="h-11 w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
