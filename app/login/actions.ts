"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth";
import { createSupabaseServerClient, supabaseConfigured } from "@/lib/supabase/server";

function backToLogin(error: string, next: string): never {
  redirect(`/login?${new URLSearchParams({ error, next })}`);
}

export async function login(formData: FormData) {
  const next = safeNextPath(formData.get("next"));
  if (!supabaseConfigured()) redirect(next);

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) backToLogin("Enter your email and password.", next);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    backToLogin(error.code === "email_not_confirmed" ? "Confirm your email address first." : "Email or password is incorrect.", next);
  }
  revalidatePath("/", "layout");
  redirect(next);
}

export async function logout() {
  if (supabaseConfigured()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  revalidatePath("/", "layout");
  redirect("/login");
}
