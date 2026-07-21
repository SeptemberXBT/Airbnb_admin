import { NextResponse } from "next/server";
import { runBookingJobs } from "@/features/bookings/job-runner";
import { verifySyncSecret } from "@/features/sync/sync-security";

export const maxDuration = 55;

export async function POST(request: Request) {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!verifySyncSecret(provided, process.env.BOOKING_CRON_SECRET ?? "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runBookingJobs();
    return NextResponse.json(result, { status: result.stageFailures > 0 ? 503 : 200 });
  } catch {
    return NextResponse.json({ error: "worker_failed" }, { status: 500 });
  }
}
