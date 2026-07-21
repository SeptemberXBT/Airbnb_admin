import { NextResponse } from "next/server";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";

export async function createBookingReadiness(sql: postgres.Sql, clock: () => Date = () => new Date()) {
  const [row] = await sql<{ last_run_at: string | null }[]>`
    select max(created_at)::text as last_run_at
    from public.audit_log where action = 'booking_worker_run'
  `;
  const elapsed = row?.last_run_at ? clock().getTime() - new Date(row.last_run_at).getTime() : Number.POSITIVE_INFINITY;
  const workerFresh = elapsed >= -60_000 && elapsed <= 3 * 60_000;
  return {
    status: workerFresh ? "ok" as const : "degraded" as const,
    timezone: "Asia/Kolkata" as const,
    database: "ready" as const,
    bookingWorker: workerFresh ? "fresh" as const : "stale" as const,
  };
}

export async function GET() {
  try {
    const readiness = await createBookingReadiness(getDb());
    return NextResponse.json(readiness, {
      status: readiness.status === "ok" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({
      status: "degraded",
      timezone: "Asia/Kolkata",
      database: "unavailable",
      bookingWorker: "unknown",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
