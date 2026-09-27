import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Supabase is optional. With NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
// set (.env.local), sign-in is required and coverage alerts live in Supabase Postgres. Without
// them the app runs as before: no sign-in, in-memory demo alerts. Only the publishable key is
// used; it is safe in the browser because row level security guards every table.

export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

export function supabaseConfigured(): boolean {
  return supabaseEnv() !== null;
}

/** A Supabase client for the current request (server components, route handlers, server actions). */
export async function createSupabaseServerClient() {
  const env = supabaseEnv();
  if (!env) throw new Error("Supabase is not configured");
  const cookieStore = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server components cannot set cookies. proxy.ts refreshes the session instead.
        }
      },
    },
  });
}

export type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
