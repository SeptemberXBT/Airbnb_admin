import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createPaymentReconciliationService } from "@/features/payments/payment-reconciliation";
import { RazorpayClientError, type RazorpayPayment } from "@/features/payments/razorpay-client";
import { orderReceipt } from "@/features/payments/order-recovery";
import { createBookingResumeService } from "./booking-resume-service";
import { createBookingRecoveryService } from "./booking-recovery-service";

const NOW = new Date("2026-07-21T10:15:00.000Z");
const HOLD_EXPIRES_AT = new Date("2026-07-21T10:20:00.000Z");
const RESUME_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64url");

async function seedHeldBooking() {
  const [property] = await testSql<{ id: string }[]>`
    insert into public.properties (name) values ('Recoverable Suite') returning id
  `;
  await testSql`
    insert into public.listings (
      property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash
    ) values (
      ${property.id}, 'Recoverable Listing', 'encrypted',
      ${`recoverable-${property.id}`}
    )
  `;
  const [booking] = await testSql<{
    id: string;
    public_reference: string;
    razorpay_order_id: string;
  }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, status, hold_expires_at, amount_paise,
      razorpay_order_id, razorpay_key_id
    ) values (
      'NH-RECOVERYFLOW01', ${property.id}, 'Recovery Guest',
      'recovery@example.test', '+919999999999', 1, '2026-08-14', '2026-08-15',
      'held', ${HOLD_EXPIRES_AT}, 500000, 'order_recovery_flow',
      'rzp_test_recovery'
    )
    returning id, public_reference, razorpay_order_id
  `;
  await testSql`
    insert into public.booking_night_prices (
      booking_id, stay_date, price_paise, price_source
    ) values (${booking.id}, '2026-08-14', 500000, 'weekday')
  `;
  await createInventoryService(testSql).withPropertyInventory(
    property.id,
    (tx) =>
      claimStayNights(tx, {
        propertyId: property.id,
        stayDates: ["2026-08-14"],
        sourceKind: "website_hold",
        sourceId: booking.id,
        expiresAt: HOLD_EXPIRES_AT,
      }),
  );
  return booking;
}

function provider(reference: string, payments: RazorpayPayment[]) {
  return {
    publicKeyId: "rzp_test_recovery",
    fetchOrder: vi.fn(async () => ({
      id: "order_recovery_flow",
      amount: 500000,
      currency: "INR" as const,
      receipt: orderReceipt(reference),
      status: "created",
    })),
    fetchOrderPayments: vi.fn(async () => payments),
  };
}

async function setupRecovery(payments: RazorpayPayment[]) {
  const booking = await seedHeldBooking();
  const resumeTokens = createBookingResumeService(testSql, {
    encryptionKey: RESUME_ENCRYPTION_KEY,
    clock: () => NOW,
  });
  const token = await resumeTokens.issue(booking.id, HOLD_EXPIRES_AT);
  const reconciliation = createPaymentReconciliationService(testSql, {
    razorpay: provider(booking.public_reference, payments),
    clock: () => NOW,
  });
  const recovery = createBookingRecoveryService({
    resumeTokens,
    reconciliation,
  });
  return { booking, token, recovery, resumeTokens };
}

describe("same-browser checkout recovery", () => {
  beforeEach(resetDb);

  it("resumes the original held booking and Razorpay order", async () => {
    const { booking, token, recovery } = await setupRecovery([]);

    await expect(
      recovery.resume(booking.public_reference, token),
    ).resolves.toEqual({
      kind: "resumable",
      bookingReference: booking.public_reference,
      orderId: booking.razorpay_order_id,
      razorpayKeyId: "rzp_test_recovery",
      holdExpiresAt: HOLD_EXPIRES_AT.toISOString(),
    });
    expect(
      await testSql`select id from public.inventory_nights where status = 'active'`,
    ).toHaveLength(1);
  });

  it("releases immediately only after provider-verified cancellation", async () => {
    const { booking, token, recovery, resumeTokens } = await setupRecovery([]);

    await expect(
      recovery.cancel(booking.public_reference, token),
    ).resolves.toMatchObject({ status: "expired" });
    expect(
      await testSql`select id from public.inventory_nights where status = 'active'`,
    ).toHaveLength(0);
    await expect(
      resumeTokens.authorize(booking.public_reference, token, NOW),
    ).rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_REVOKED" });
  });

  it("retains uncertain and authorized attempts instead of reopening Checkout", async () => {
    const authorized = await setupRecovery([
      { id: "pay_authorized", status: "authorized", amount: 500000 },
    ]);
    await expect(
      authorized.recovery.resume(
        authorized.booking.public_reference,
        authorized.token,
      ),
    ).resolves.toMatchObject({ status: "payment_pending" });

    await resetDb();
    const booking = await seedHeldBooking();
    const resumeTokens = createBookingResumeService(testSql, {
      encryptionKey: RESUME_ENCRYPTION_KEY,
      clock: () => NOW,
    });
    const token = await resumeTokens.issue(booking.id, HOLD_EXPIRES_AT);
    const unavailable = createBookingRecoveryService({
      resumeTokens,
      reconciliation: createPaymentReconciliationService(testSql, {
        razorpay: {
          publicKeyId: "rzp_test_recovery",
          fetchOrder: vi.fn(),
          fetchOrderPayments: vi.fn(async () => {
            throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE");
          }),
        },
        clock: () => NOW,
      }),
    });
    await expect(
      unavailable.resume(booking.public_reference, token),
    ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_RETRYABLE" });
    expect(
      await testSql`select id from public.inventory_nights where status = 'active'`,
    ).toHaveLength(1);
  });
});
