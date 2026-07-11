import { runCalendarSync } from "@/features/sync/sync-service";
import { verifySyncSecret } from "@/features/sync/sync-security";
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!verifySyncSecret(provided, process.env.SYNC_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runCalendarSync("scheduled");
  return NextResponse.json(result, { status: result.status === "locked" ? 409 : 200 });
}
