import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createRefundService, RefundProviderError } from "./refund-service";

const NOW = new Date("2026-07-21T23:00:00.000Z");
let bookingId: string;

describe("refund lifecycle worker", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "admin@example.test");
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Refund Suite') returning id`;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_payment_id, refund_status,
        cancellation_reason, cancelled_at
      ) values ('NH-REFUNDTEST001', ${property.id}, 'Refund Guest', 'refund@example.test', '+919999999999', 1,
        '2026-08-14', '2026-08-15', 'cancelled', 500000, 'pay_refund_1', 'pending',
        'airbnb_collision', ${NOW}) returning id
    `;
    bookingId = booking.id;
    await testSql`
      insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, next_attempt_at)
      values (${bookingId}, 'refund', ${`collision-refund:${bookingId}`}, 'pending', ${NOW})
    `;
  });

  it("reconciles an existing processed refund and enqueues separate confirmation", async () => {
    const provider = {
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

  it("keeps an ambiguous refund retryable and reconciles before any repeat create", async () => {
    const provider = {
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
      findRefund: vi.fn(async () => null),
      createFullRefund: vi.fn(async () => { throw new RefundProviderError("definitive", "REFUND_REJECTED"); }),
    };
    const service = createRefundService(testSql, { provider, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ processed: 0, retryable: 0, failed: 1 });
    const [booking] = await testSql<{ refund_status: string }[]>`select refund_status from public.bookings where id = ${bookingId}`;
    expect(booking.refund_status).toBe("failed");
    expect(await testSql`select id from public.notification_outbox where template_key = 'refund_failed_admin'`).toHaveLength(1);
  });
});
