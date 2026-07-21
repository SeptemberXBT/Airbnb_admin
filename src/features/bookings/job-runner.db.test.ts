import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { recoverStaleBookingLeases } from "./job-runner";

const NOW = new Date("2026-07-21T10:15:00.000Z");
const STALE = new Date("2026-07-21T10:13:00.000Z");
const FRESH = new Date("2026-07-21T10:16:00.000Z");

describe("stale booking worker leases", () => {
  beforeEach(resetDb);

  it("atomically recovers stale attempt, payment, and outbox leases without touching live leases", async () => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Lease Suite') returning id`;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_order_id
      ) values (
        'NH-STALELEASE123', ${property.id}, 'Lease Guest', 'lease@example.test', '+919999999999', 1,
        '2026-08-14', '2026-08-15', 'held', 500000, 'order_stale_lease'
      ) returning id
    `;
    await testSql`
      insert into public.booking_attempts (
        idempotency_key, request_hash, status, durable_step, lease_token, lease_expires_at
      ) values
        ('10000000-0000-4000-8000-000000000010', ${"a".repeat(64)}, 'processing', 'hold_created', '10000000-0000-4000-8000-000000000011', ${STALE}),
        ('10000000-0000-4000-8000-000000000012', ${"b".repeat(64)}, 'processing', 'started', '10000000-0000-4000-8000-000000000013', ${FRESH})
    `;
    await testSql`
      insert into public.payment_jobs (
        booking_id, job_kind, idempotency_identity, status, lease_token, lease_expires_at
      ) values
        (${booking.id}, 'payment_reconciliation', 'stale-payment-job', 'processing', '10000000-0000-4000-8000-000000000014', ${STALE}),
        (${booking.id}, 'payment_reconciliation', 'fresh-payment-job', 'processing', '10000000-0000-4000-8000-000000000015', ${FRESH})
    `;
    await testSql`
      insert into public.notification_outbox (
        booking_id, recipient_kind, recipient_email, template_key, deduplication_key,
        subject, html_body, text_body, status, lease_token, lease_expires_at
      ) values
        (${booking.id}, 'guest', 'lease@example.test', 'test', 'stale-notice', 'Test', '<p>Test</p>', 'Test', 'processing', '10000000-0000-4000-8000-000000000016', ${STALE}),
        (${booking.id}, 'guest', 'lease@example.test', 'test', 'fresh-notice', 'Test', '<p>Test</p>', 'Test', 'processing', '10000000-0000-4000-8000-000000000017', ${FRESH})
    `;

    expect(await recoverStaleBookingLeases(testSql, NOW, 10)).toBe(3);

    const attempts = await testSql<{ status: string; lease_token: string | null }[]>`select status, lease_token::text from public.booking_attempts order by idempotency_key`;
    expect(attempts).toEqual([
      { status: "retryable_failure", lease_token: null },
      { status: "processing", lease_token: "10000000-0000-4000-8000-000000000013" },
    ]);
    const jobs = await testSql<{ status: string }[]>`select status from public.payment_jobs order by idempotency_identity desc`;
    expect(jobs).toEqual([{ status: "retryable_failure" }, { status: "processing" }]);
    const notices = await testSql<{ status: string }[]>`select status from public.notification_outbox order by deduplication_key desc`;
    expect(notices).toEqual([{ status: "retryable_failure" }, { status: "processing" }]);
  });
});
