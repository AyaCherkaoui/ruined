import { ApiError } from "./http";
import { createSupabaseServerClient, supabaseConfigured, type SupabaseServerClient } from "./supabase/server";

export interface SignedInUser {
  id: string;
  email: string | null;
}

export interface Session {
  user: SignedInUser;
  supabase: SupabaseServerClient;
}

/**
 * Server-side check for protected operations. getUser() asks Supabase Auth to verify the
 * session, so a forged or expired cookie is rejected.
 * Returns null when Supabase is not configured (local demo mode: no sign-in).
 * Throws a 401 ApiError when Supabase is configured and nobody is signed in.
 */
export async function requireUser(): Promise<Session | null> {
  if (!supabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ApiError(401, "Sign in required");
  return { user: { id: data.user.id, email: data.user.email ?? null }, supabase };
}

/**
 * Where to go after sign-in. Only same-site paths, so ?next= can't send a doctor to
 * another site.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}
