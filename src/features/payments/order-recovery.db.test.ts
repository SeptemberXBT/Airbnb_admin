import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import { processOrderRecoveryJobs } from "./order-recovery";

const NOW = new Date("2026-07-21T10:15:00.000Z");
const RESUME_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64url");

async function seed(expiresAt: Date) {
  const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Recovery Suite') returning id`;
  const [booking] = await testSql<{ id: string; public_reference: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
      checkin, checkout, status, hold_expires_at, amount_paise
    ) values ('NH-ORDERRECOVERY12', ${property.id}, 'Recovery Guest', 'recovery@example.test', '+919999999999', 1,
      '2026-08-14', '2026-08-15', 'held', ${expiresAt}, 500000) returning id, public_reference
  `;
  await createInventoryService(testSql).withPropertyInventory(property.id, (tx) => claimStayNights(tx, {
    propertyId: property.id,
    stayDates: ["2026-08-14"],
    sourceKind: "website_hold",
    sourceId: booking.id,
    expiresAt,
  }));
  await testSql`
    insert into public.booking_attempts (
      idempotency_key, request_hash, status, durable_step, booking_id, lease_expires_at
    ) values ('10000000-0000-4000-8000-000000000099', ${"a".repeat(64)}, 'retryable_failure',
      'razorpay_order_pending', ${booking.id}, ${NOW})
  `;
  await testSql`
    insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, next_attempt_at)
    values (${booking.id}, 'order_recovery', ${`order-recovery:${booking.id}`}, ${NOW})
  `;
  return { property, booking };
}

describe("Razorpay order recovery worker", () => {
  beforeEach(resetDb);

  it("attaches a receipt-recovered order and completes the abandoned attempt", async () => {
    const { booking } = await seed(new Date("2026-07-21T10:20:00.000Z"));
    const provider = {
      publicKeyId: "rzp_test_public",
      findOrderByReceipt: vi.fn(async () => ({
        id: "order_recovered", amount: 500000, currency: "INR" as const,
        receipt: `nh_${booking.public_reference}`, status: "created",
      })),
    };

    expect(await processOrderRecoveryJobs(testSql, provider, {
      now: NOW,
      limit: 10,
      resumeEncryptionKey: RESUME_ENCRYPTION_KEY,
    })).toEqual({ processed: 1, failed: 0 });
    await expect(testSql`select razorpay_order_id from public.bookings`).resolves.toEqual([{ razorpay_order_id: "order_recovered" }]);
    await expect(testSql`select status, provider_id from public.payment_jobs`).resolves.toEqual([{ status: "succeeded", provider_id: "order_recovered" }]);
    const [attempt] = await testSql<{ status: string; terminal_response: { orderId: string } }[]>`select status, terminal_response from public.booking_attempts`;
    expect(attempt.status).toBe("succeeded");
    expect(attempt.terminal_response.orderId).toBe("order_recovered");
    expect(attempt.terminal_response).not.toHaveProperty("resumeToken");
    expect(await testSql`select booking_id from public.booking_resume_tokens`).toHaveLength(1);
  });

  it("releases an expired hold only after a successful receipt lookup proves no order exists", async () => {
    await seed(new Date("2026-07-21T10:10:00.000Z"));
    const provider = { publicKeyId: "rzp_test_public", findOrderByReceipt: vi.fn(async () => null) };

    expect(await processOrderRecoveryJobs(testSql, provider, { now: NOW, limit: 10 })).toEqual({ processed: 1, failed: 0 });
    await expect(testSql`select status from public.bookings`).resolves.toEqual([{ status: "payment_failed" }]);
    await expect(testSql`select id from public.inventory_nights where status = 'active'`).resolves.toHaveLength(0);
    await expect(testSql`select status from public.payment_jobs`).resolves.toEqual([{ status: "definitive_failure" }]);
    await expect(testSql`select status from public.booking_attempts`).resolves.toEqual([{ status: "definitive_failure" }]);
  });

  it("retains inventory and retries when provider lookup is ambiguous", async () => {
    await seed(new Date("2026-07-21T10:10:00.000Z"));
    const provider = { publicKeyId: "rzp_test_public", findOrderByReceipt: vi.fn(async () => { throw new Error("offline"); }) };

    expect(await processOrderRecoveryJobs(testSql, provider, { now: NOW, limit: 10 })).toEqual({ processed: 0, failed: 1 });
    await expect(testSql`select id from public.inventory_nights where status = 'active'`).resolves.toHaveLength(1);
    await expect(testSql`select status from public.payment_jobs`).resolves.toEqual([{ status: "retryable_failure" }]);
  });

  it("terminally closes recovery without contacting Razorpay when the booking is already cancelled", async () => {
    const { property, booking } = await seed(new Date("2026-07-21T10:20:00.000Z"));
    await createInventoryService(testSql).withPropertyInventory(property.id, async (tx) => {
      await tx`update public.bookings set status = 'cancelled', cancellation_reason = 'airbnb_collision' where id = ${booking.id}`;
      await releaseSourceNights(tx, "website_hold", booking.id, "airbnb_collision");
    });
    const provider = { publicKeyId: "rzp_test_public", findOrderByReceipt: vi.fn() };

    expect(await processOrderRecoveryJobs(testSql, provider, { now: NOW, limit: 10 })).toEqual({ processed: 1, failed: 0 });
    expect(provider.findOrderByReceipt).not.toHaveBeenCalled();
    await expect(testSql`select status, razorpay_order_id from public.bookings`).resolves.toEqual([
      { status: "cancelled", razorpay_order_id: null },
    ]);
    await expect(testSql`select status, last_error_code from public.payment_jobs`).resolves.toEqual([
      { status: "definitive_failure", last_error_code: "booking_no_longer_active" },
    ]);
    await expect(testSql`select status, terminal_response from public.booking_attempts`).resolves.toEqual([
      { status: "definitive_failure", terminal_response: { error: "booking_no_longer_active" } },
    ]);
  });

  it("does not attach an order when Airbnb cancels the hold during provider lookup", async () => {
    const { property, booking } = await seed(new Date("2026-07-21T10:20:00.000Z"));
    const provider = {
      publicKeyId: "rzp_test_public",
      findOrderByReceipt: vi.fn(async () => {
        await createInventoryService(testSql).withPropertyInventory(property.id, async (tx) => {
          await tx`update public.bookings set status = 'cancelled', cancellation_reason = 'airbnb_collision' where id = ${booking.id}`;
          await releaseSourceNights(tx, "website_hold", booking.id, "airbnb_collision");
        });
        return {
          id: "order_too_late", amount: 500000, currency: "INR" as const,
          receipt: `nh_${booking.public_reference}`, status: "created",
        };
      }),
    };

    expect(await processOrderRecoveryJobs(testSql, provider, { now: NOW, limit: 10 })).toEqual({ processed: 1, failed: 0 });
    await expect(testSql`select status, razorpay_order_id from public.bookings`).resolves.toEqual([
      { status: "cancelled", razorpay_order_id: null },
    ]);
    await expect(testSql`select status, provider_id from public.payment_jobs`).resolves.toEqual([
      { status: "definitive_failure", provider_id: "order_too_late" },
    ]);
  });
});
