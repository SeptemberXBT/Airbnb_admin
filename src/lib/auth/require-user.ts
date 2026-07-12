import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AppUser = { id: string; email?: string };

export async function getCurrentUser(): Promise<AppUser | null> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") {
    return { id: "00000000-0000-4000-8000-000000000001", email: "demo@example.test" };
  }
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { id: user.id, email: user.email } : null;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}
