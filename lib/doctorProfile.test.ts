import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ configured: true, client: null as unknown }));

vi.mock("./supabase/server", () => ({
  supabaseConfigured: () => auth.configured,
  supabaseEnv: () => (auth.configured ? { url: "http://supabase.test", key: "sb_publishable_test" } : null),
  createSupabaseServerClient: async () => auth.client,
}));

import { getCurrentDoctorProfile } from "./doctorProfile";

type Row = Record<string, unknown>;

/** Enough of supabase-js for .from().select().eq().maybeSingle(), with RLS-like own-row filtering. */
function fakeSupabase(rows: Row[], userId: string | null, missingTable = false) {
  const queried: [string, unknown][] = [];
  return {
    queried,
    from: () => {
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => (filters.push([col, val]), queried.push([col, val]), b),
        maybeSingle: async () => {
          if (missingTable) return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
          const visible = rows.filter((r) => r.user_id === userId); // row level security
          return { data: visible.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null, error: null };
        },
      };
      return b;
    },
    auth: {
      getUser: async () =>
        userId ? { data: { user: { id: userId, email: "doctor@test.com" } }, error: null } : { data: { user: null }, error: { message: "Auth session missing!" } },
    },
  };
}

const ROWS: Row[] = [
  {
    user_id: "user-a",
    name: "Dr. Test Doctor",
    npi: "0000000000",
    specialty: "Cardiology",
    organization: "Demo Cardiology Clinic (test)",
    phone: "+1 404-555-0100",
    created_at: "2026-09-27T12:00:00+00:00",
    updated_at: "2026-09-27T12:30:00+00:00",
  },
  { user_id: "user-b", name: "Dr. Someone Else", npi: null, specialty: null, organization: null, phone: null, created_at: "2026-09-27T12:00:00Z", updated_at: "2026-09-27T12:00:00Z" },
];

beforeEach(() => {
  auth.configured = true;
});

describe("getCurrentDoctorProfile", () => {
  it("is null when Supabase is not configured (local demo mode)", async () => {
    auth.configured = false;
    expect(await getCurrentDoctorProfile()).toBeNull();
  });

  it("throws a 401 when signed out", async () => {
    auth.client = fakeSupabase(ROWS, null);
    await expect(getCurrentDoctorProfile()).rejects.toMatchObject({ status: 401 });
  });

  it("returns the signed-in doctor's own profile, filtered by the verified user id", async () => {
    const client = fakeSupabase(ROWS, "user-a");
    auth.client = client;
    expect(await getCurrentDoctorProfile()).toEqual({
      userId: "user-a",
      name: "Dr. Test Doctor",
      npi: "0000000000",
      specialty: "Cardiology",
      organization: "Demo Cardiology Clinic (test)",
      phone: "+1 404-555-0100",
      createdAt: "2026-09-27T12:00:00.000Z",
      updatedAt: "2026-09-27T12:30:00.000Z",
    });
    expect(client.queried).toEqual([["user_id", "user-a"]]);
  });

  it("a different doctor gets their own profile, not user-a's", async () => {
    auth.client = fakeSupabase(ROWS, "user-b");
    expect(await getCurrentDoctorProfile()).toMatchObject({ userId: "user-b", name: "Dr. Someone Else" });
  });

  it("is null when the doctor has no profile yet", async () => {
    auth.client = fakeSupabase(ROWS, "user-without-profile");
    expect(await getCurrentDoctorProfile()).toBeNull();
  });

  it("503 with setup instructions when the table was never created", async () => {
    auth.client = fakeSupabase(ROWS, "user-a", true);
    await expect(getCurrentDoctorProfile()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/doctor_profiles\.sql/) });
  });
});

describe("doctor_profiles SQL", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), "supabase", file), "utf8");
  const migration = read("migrations/20260927020000_doctor_profiles.sql");
  const seed = read("seed-test-doctor-profile.sql");
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it("has RLS on and only own-row select and update policies", () => {
    expect(migration).toMatch(/alter table public\.doctor_profiles enable row level security/);
    expect(migration.match(/create policy/g)).toHaveLength(2);
    expect(migration).toMatch(/for select to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(migration).toMatch(/for update to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)\s+with check \(\(select auth\.uid\(\)\) = user_id\)/);
    expect(migration).not.toMatch(/for (insert|delete|all)/);
  });

  it("stores no passwords and no patient data, and touches no other table", () => {
    const statements = migration.replace(/--.*$/gm, ""); // comments explain what is NOT stored
    expect(statements).not.toMatch(/password|patient|diagnos/i);
    expect(migration.match(/create table/g)).toHaveLength(1);
  });

  it("the test seed finds the user by email, never by a hardcoded UUID", () => {
    expect(seed).toMatch(/where email = 'doctor@test\.com'/);
    expect(seed).not.toMatch(UUID);
    expect(migration).not.toMatch(UUID);
  });
});
