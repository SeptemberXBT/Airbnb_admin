import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { cleanupExpiredNonces } from "@/features/internal-api/request-auth";
import { createAttemptService } from "./attempt-service";
import { processExpiredHolds } from "./hold-expiry";
import { createPaymentReconciliationService, type PaymentReconciliationService } from "@/features/payments/payment-reconciliation";
import { createRazorpayClient } from "@/features/payments/razorpay-client";
import { createRazorpayRefundProvider, createRefundService } from "@/features/payments/refund-service";
import { createZeptoMailClient } from "@/features/email/zeptomail-client";
import { createNotificationOutboxService } from "@/features/email/outbox-service";

type StageContext = { now: Date; limit: number };
export type JobStageResult = { processed: number; failed: number };
type Stage = (context: StageContext) => Promise<JobStageResult>;
type BookingJobDependencies = {
  expiredHolds: Stage;
  paymentReconciliation: Stage;
  refunds: Stage;
  notifications: Stage;
  nonceCleanup: Stage;
  staleLeaseRecovery: Stage;
  replayBodyCleanup: Stage;
  recordRun(now: Date, result: BookingJobRunResult): Promise<void>;
};

const stageNames = [
  "expiredHolds",
  "paymentReconciliation",
  "refunds",
  "notifications",
  "nonceCleanup",
  "staleLeaseRecovery",
  "replayBodyCleanup",
] as const;

export type BookingJobRunResult = Record<(typeof stageNames)[number], JobStageResult> & { stageFailures: number };

function validateStageResult(result: JobStageResult) {
  if (!Number.isInteger(result.processed) || result.processed < 0 || !Number.isInteger(result.failed) || result.failed < 0) {
    throw new Error("INVALID_JOB_STAGE_RESULT");
  }
  return result;
}

export function createBookingJobRunner(
  dependencies: BookingJobDependencies,
  options: { clock?: () => Date; batchLimit?: number } = {},
) {
  const clock = options.clock ?? (() => new Date());
  const batchLimit = options.batchLimit ?? 25;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new Error("INVALID_BOOKING_JOB_LIMIT");

  return {
    async run(): Promise<BookingJobRunResult> {
      const now = clock();
      const settled = await Promise.all(stageNames.map(async (name) => {
        try {
          return [name, validateStageResult(await dependencies[name]({ now, limit: batchLimit })), false] as const;
        } catch {
          return [name, { processed: 0, failed: 1 }, true] as const;
        }
      }));
      const result = { stageFailures: settled.filter(([, , failed]) => failed).length } as BookingJobRunResult;
      for (const [name, counts] of settled) result[name] = counts;
      await dependencies.recordRun(now, result);
      return result;
    },
  };
}

async function processPaymentReconciliationJobs(
  sql: postgres.Sql,
  reconciliation: Pick<PaymentReconciliationService, "reconcileBooking">,
  { now, limit }: StageContext,
): Promise<JobStageResult> {
  const leaseToken = randomUUID();
  const rows = await sql<{ id: string; public_reference: string; attempt_count: number }[]>`
    with ready as (
      select id from public.payment_jobs
      where job_kind = 'payment_reconciliation'
        and status in ('pending', 'retryable_failure') and next_attempt_at <= ${now}
      order by next_attempt_at, created_at
      limit ${limit}
      for update skip locked
    )
    update public.payment_jobs j
    set status = 'processing', lease_token = ${leaseToken},
      lease_expires_at = ${new Date(now.getTime() + 60_000)},
      attempt_count = attempt_count + 1, updated_at = ${now}
    from ready, public.bookings b
    where j.id = ready.id and b.id = j.booking_id
    returning j.id, b.public_reference, j.attempt_count
  `;
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await reconciliation.reconcileBooking(row.public_reference, "worker");
      await sql`
        update public.payment_jobs
        set status = 'succeeded', lease_token = null, lease_expires_at = null,
          last_error_code = null, updated_at = ${now}
        where id = ${row.id} and lease_token = ${leaseToken}
      `;
      processed += 1;
    } catch {
      const delayMinutes = Math.min(60, 2 ** Math.min(row.attempt_count, 6));
      await sql`
        update public.payment_jobs
        set status = 'retryable_failure', lease_token = null, lease_expires_at = null,
          next_attempt_at = ${new Date(now.getTime() + delayMinutes * 60_000)},
          last_error_code = 'reconciliation_failed', updated_at = ${now}
        where id = ${row.id} and lease_token = ${leaseToken}
      `;
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function recoverStaleBookingLeases(sql: postgres.Sql, now: Date, limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_STALE_LEASE_LIMIT");
  const [attempts, payments, notifications] = await sql.begin(async (tx) => Promise.all([
    tx<{ idempotency_key: string }[]>`
      with stale as (
        select idempotency_key from public.booking_attempts
        where status = 'processing' and lease_expires_at <= ${now}
        order by lease_expires_at limit ${limit} for update skip locked
      )
      update public.booking_attempts a set status = 'retryable_failure', lease_token = null, updated_at = ${now}
      from stale where a.idempotency_key = stale.idempotency_key returning a.idempotency_key
    `,
    tx<{ id: string }[]>`
      with stale as (
        select id from public.payment_jobs where status = 'processing' and lease_expires_at <= ${now}
        order by lease_expires_at limit ${limit} for update skip locked
      )
      update public.payment_jobs j set status = 'retryable_failure', lease_token = null,
        lease_expires_at = null, next_attempt_at = ${now}, updated_at = ${now}
      from stale where j.id = stale.id returning j.id
    `,
    tx<{ id: string }[]>`
      with stale as (
        select id from public.notification_outbox where status = 'processing' and lease_expires_at <= ${now}
        order by lease_expires_at limit ${limit} for update skip locked
      )
      update public.notification_outbox o set status = 'retryable_failure', lease_token = null,
        lease_expires_at = null, next_attempt_at = ${now}, updated_at = ${now}
      from stale where o.id = stale.id returning o.id
    `,
  ]));
  return attempts.length + payments.length + notifications.length;
}

function requiredWorkerEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BOOKING_WORKER_NOT_CONFIGURED");
  return value;
}

export function createConfiguredBookingJobRunner() {
  const sql = getDb();
  const keyId = requiredWorkerEnvironment("RAZORPAY_KEY_ID");
  const keySecret = requiredWorkerEnvironment("RAZORPAY_KEY_SECRET");
  const razorpay = createRazorpayClient({ keyId, keySecret });
  const reconciliation = createPaymentReconciliationService(sql, { razorpay });
  const refunds = createRefundService(sql, {
    provider: createRazorpayRefundProvider({ keyId, keySecret }),
  });
  const notifications = createNotificationOutboxService(sql, {
    mailer: createZeptoMailClient({
      token: requiredWorkerEnvironment("ZEPTOMAIL_TOKEN"),
      senderAddress: requiredWorkerEnvironment("ZEPTOMAIL_SENDER_ADDRESS"),
      senderName: process.env.ZEPTOMAIL_SENDER_NAME?.trim() || "Noir Haus",
    }),
  });
  const attempts = createAttemptService(sql);

  return createBookingJobRunner({
    expiredHolds: async ({ now, limit }) => processExpiredHolds(sql, reconciliation, { now, limit }),
    paymentReconciliation: async (context) => processPaymentReconciliationJobs(sql, reconciliation, context),
    refunds: async ({ limit }) => {
      const result = await refunds.processBatch(limit);
      return { processed: result.processed + result.retryable, failed: result.failed };
    },
    notifications: async ({ limit }) => {
      const result = await notifications.processBatch(limit);
      return { processed: result.sent, failed: result.failed };
    },
    nonceCleanup: async ({ now }) => ({ processed: await cleanupExpiredNonces(sql, now), failed: 0 }),
    staleLeaseRecovery: async ({ now, limit }) => ({ processed: await recoverStaleBookingLeases(sql, now, limit), failed: 0 }),
    replayBodyCleanup: async () => ({ processed: await attempts.pruneExpiredReplayBodies(), failed: 0 }),
    recordRun: async (now, result) => {
      await sql`
        insert into public.audit_log (action, entity_type, entity_id, changes, created_at)
        values ('booking_worker_run', 'booking_worker', 'scheduled', ${sql.json(result)}, ${now})
      `;
    },
  });
}

export function runBookingJobs() {
  return createConfiguredBookingJobRunner().run();
}
