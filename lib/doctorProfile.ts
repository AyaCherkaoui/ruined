import { requireUser, type Session } from "./auth";
import { ApiError } from "./http";

// The signed-in doctor's profile (supabase/migrations/20260927020000_doctor_profiles.sql).
// Professional details only: no password, no patient data. Row level security limits every
// read to the doctor's own row, and every query here also filters by the verified user id.

export interface DoctorProfile {
  userId: string;
  name: string | null;
  npi: string | null;
  specialty: string | null;
  organization: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DoctorProfileRow {
  user_id: string;
  name: string | null;
  npi: string | null;
  specialty: string | null;
  organization: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

function toProfile(row: DoctorProfileRow): DoctorProfile {
  return {
    userId: row.user_id,
    name: row.name,
    npi: row.npi,
    specialty: row.specialty,
    organization: row.organization,
    phone: row.phone,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** The profile of the session's user, or null if none has been created yet. */
export async function doctorProfileFor({ supabase, user }: Session): Promise<DoctorProfile | null> {
  const { data, error } = await supabase
    .from("doctor_profiles")
    .select("user_id, name, npi, specialty, organization, phone, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    // PGRST205 / 42P01: the table does not exist yet.
    if (error.code === "PGRST205" || error.code === "42P01") {
      throw new ApiError(503, "Doctor profiles table is missing. Run supabase/migrations/20260927020000_doctor_profiles.sql in the Supabase SQL Editor.");
    }
    throw new Error(`Supabase reading the doctor profile failed: ${error.message}`);
  }
  return data ? toProfile(data as DoctorProfileRow) : null;
}

/**
 * The currently signed-in doctor's profile.
 * - null when Supabase is not configured (local demo mode) or the doctor has no profile yet
 * - throws a 401 ApiError when Supabase is configured and nobody is signed in
 */
export async function getCurrentDoctorProfile(): Promise<DoctorProfile | null> {
  const session = await requireUser();
  return session ? doctorProfileFor(session) : null;
}
