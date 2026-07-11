import { runCalendarSync } from "@/features/sync/sync-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST() {
  try {
    const user = await requireUser();
    const result = await runCalendarSync("manual", user.id);
    const status = result.status === "locked" ? 409 : result.status === "cooldown" ? 429 : 200;
    return NextResponse.json(result, { status });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
