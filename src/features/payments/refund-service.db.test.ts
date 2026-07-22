import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createRefundService, RefundProviderError } from "./refund-service";

const NOW = new Date("2026-07-21T23:00:00.000Z");
const RAZORPAY_KEY_ID = "rzp_test_refundworker";
let bookingId: string;

describe("refund lifecycle worker", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "admin@example.test");
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Refund Suite') returning id`;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_order_id, razorpay_payment_id, refund_status,
        cancellation_reason, razorpay_key_id, cancelled_at
      ) values ('NH-REFUNDTEST001', ${property.id}, 'Refund Guest', 'refund@example.test', '+919999999999', 1,
        '2026-08-14', '2026-08-15', 'cancelled', 500000, 'order_refund_1', 'pay_refund_1', 'pending',
        'airbnb_collision', ${RAZORPAY_KEY_ID}, ${NOW}) returning id
    `;
    bookingId = booking.id;
    await testSql`
      insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, next_attempt_at)
      values (${bookingId}, 'refund', ${`refund:${bookingId}`}, 'pending', ${NOW})
    `;
  });

  it("reconciles an existing processed refund and enqueues separate confirmation", async () => {
    const provider = {
      publicKeyId: RAZORPAY_KEY_ID,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_refund_1", status: "captured", amount: 500000 }]),
      findRefund: vi.fn(async () => ({ id: "rfnd_processed", status: "processed" as const })),
      createFullRefund: vi.fn(),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 1, retryable: 0, failed: 0 });
    expect(provider.createFullRefund).not.toHaveBeenCalled();
    const [booking] = await testSql<{ refund_status: string; razorpay_refund_id: string }[]>`
      select refund_status, razorpay_refund_id from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({ refund_status: "processed", razorpay_refund_id: "rfnd_processed" });
    expect(await testSql`select id from public.notification_outbox where template_key = 'refund_processed'`).toHaveLength(1);
  });

  it("discovers a pre-migration provider refund through its preserved legacy identity", async () => {
    const [job] = await testSql<{ id: string }[]>`
      select id from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'
    `;
    const legacyIdentity = `collision-refund:${bookingId}`;
    await testSql`
      insert into public.payment_refund_job_aliases (
        idempotency_identity, booking_id, consolidated_into_job_id, original_job_id,
        status, provider_id, terminal_result, last_error_code, created_at, updated_at
      ) values (
        ${legacyIdentity}, ${bookingId}, ${job.id}, '20000000-0000-4000-8000-000000000001',
        'pending', 'rfnd_legacy', null, null, ${NOW}, ${NOW}
      )
    `;
    const provider = {
      publicKeyId: RAZORPAY_KEY_ID,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_refund_1", status: "captured", amount: 500000 }]),
      findRefund: vi.fn(async (_paymentId: string, identity: string) => identity === legacyIdentity
        ? { id: "rfnd_legacy", status: "processed" as const }
        : null),
      createFullRefund: vi.fn(),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 1, retryable: 0, failed: 0 });
    expect(provider.findRefund).toHaveBeenCalledWith("pay_refund_1", legacyIdentity);
    expect(provider.createFullRefund).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous refund retryable and reconciles before any repeat create", async () => {
    const provider = {
      publicKeyId: RAZORPAY_KEY_ID,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_refund_1", status: "captured", amount: 500000 }]),
      findRefund: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "rfnd_after_timeout", status: "pending" as const }),
      createFullRefund: vi.fn(async () => { throw new RefundProviderError("ambiguous", "REFUND_UNAVAILABLE"); }),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 0, retryable: 1, failed: 0 });
    await testSql`update public.payment_jobs set next_attempt_at = ${NOW}, status = 'retryable_failure' where booking_id = ${bookingId}`;
    expect(await service.processBatch(10)).toEqual({ processed: 0, retryable: 1, failed: 0 });
    expect(provider.createFullRefund).toHaveBeenCalledOnce();
    const [job] = await testSql<{ provider_id: string; status: string }[]>`select provider_id, status from public.payment_jobs`;
    expect(job).toEqual({ provider_id: "rfnd_after_timeout", status: "retryable_failure" });
  });

  it("marks a definitive refund failure and creates an admin alert", async () => {
    const provider = {
      publicKeyId: RAZORPAY_KEY_ID,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_refund_1", status: "captured", amount: 500000 }]),
      findRefund: vi.fn(async () => null),
      createFullRefund: vi.fn(async () => { throw new RefundProviderError("definitive", "REFUND_REJECTED"); }),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 0, retryable: 0, failed: 1 });
    const [booking] = await testSql<{ refund_status: string }[]>`select refund_status from public.bookings where id = ${bookingId}`;
    expect(booking.refund_status).toBe("failed");
    expect(await testSql`select id from public.notification_outbox where template_key = 'refund_failed_admin'`).toHaveLength(1);
  });

  it("verifies and atomically binds a legacy or rotated account before refunding", async () => {
    await testSql`update public.bookings set razorpay_key_id = null where id = ${bookingId}`;
    const rotatedKeyId = "rzp_test_rotatedworker";
    const provider = {
      publicKeyId: rotatedKeyId,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_refund_1", status: "captured", amount: 500000 }]),
      findRefund: vi.fn(async () => null),
      createFullRefund: vi.fn(async () => ({ id: "rfnd_rotated", status: "pending" as const })),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 0, retryable: 1, failed: 0 });
    const [booking] = await testSql<{ razorpay_key_id: string; refund_status: string }[]>`
      select razorpay_key_id, refund_status from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({ razorpay_key_id: rotatedKeyId, refund_status: "pending" });
    expect(provider.createFullRefund).toHaveBeenCalledOnce();
    expect(await testSql`select id from public.audit_log where entity_id = ${bookingId} and action = 'razorpay_account_rebound'`).toHaveLength(1);
    expect(await testSql`select id from public.notification_outbox where booking_id = ${bookingId} and template_key = 'late_payment_refund'`).toHaveLength(0);
  });
});
