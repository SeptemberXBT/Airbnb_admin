import { NextResponse } from "next/server";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";

export async function createBookingReadiness(sql: postgres.Sql, clock: () => Date = () => new Date()) {
  const [row] = await sql<{ last_run_at: string | null; last_stage_failures: number; operations_failure: boolean }[]>`
    select
      latest.created_at::text as last_run_at,
      coalesce((latest.changes->>'stageFailures')::int, 0) as last_stage_failures,
      (
        exists (select 1 from public.notification_outbox where status = 'failed')
        or exists (
          select 1 from public.payment_jobs
          where job_kind = 'refund' and status = 'definitive_failure'
        )
      ) as operations_failure
    from (select created_at, changes from public.audit_log where action = 'booking_worker_run' order by created_at desc limit 1) latest
  `;
  const elapsed = row?.last_run_at ? clock().getTime() - new Date(row.last_run_at).getTime() : Number.POSITIVE_INFINITY;
  const workerFresh = elapsed >= -60_000 && elapsed <= 3 * 60_000;
  const workerDegraded = Boolean(row?.operations_failure || (row?.last_stage_failures ?? 0) > 0);
  const workerHealthy = workerFresh && !workerDegraded;
  return {
    status: workerHealthy ? "ok" as const : "degraded" as const,
    timezone: "Asia/Kolkata" as const,
    database: "ready" as const,
    bookingWorker: !workerFresh ? "stale" as const : workerDegraded ? "degraded" as const : "fresh" as const,
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
