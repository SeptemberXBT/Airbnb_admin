import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import { createPaymentReconciliationService } from "./payment-reconciliation";
import { RazorpayClientError, type RazorpayPayment } from "./razorpay-client";

const NOW = new Date("2026-07-21T10:15:00.000Z");
let sequence = 0;
let propertyId: string;
let listingId: string;

function fakeRazorpay(payments: RazorpayPayment[]) {
  return { publicKeyId: "rzp_test_reconciliation", fetchOrderPayments: vi.fn(async () => payments) };
}

async function addHeldBooking(status = "held", expiresAt = new Date("2026-07-21T10:10:00.000Z")) {
  sequence += 1;
  const [booking] = await testSql<{ id: string; public_reference: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
      checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id
    ) values (
      ${`NH-PAYMENTTEST${String(sequence).padStart(3, "0")}`}, ${propertyId}, 'Payment Guest',
      'payment@example.test', '+919999999999', 2, '2026-08-14', '2026-08-16',
      ${status}, ${expiresAt}, 1200000, ${`order_payment_${sequence}`}
    ) returning id, public_reference
  `;
  await createInventoryService(testSql).withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
    propertyId,
    stayDates: ["2026-08-14", "2026-08-15"],
    sourceKind: "website_hold",
    sourceId: booking.id,
    expiresAt,
  }));
  return booking;
}

async function bookingState(id: string) {
  const [booking] = await testSql<{ status: string; razorpay_payment_id: string | null; refund_status: string }[]>`
    select status, razorpay_payment_id, refund_status from public.bookings where id = ${id}
  `;
  return booking;
}

async function activeKinds() {
  return testSql<{ source_kind: string }[]>`
    select source_kind from public.inventory_nights where property_id = ${propertyId} and status = 'active' order by stay_date
  `;
}

describe("payment reconciliation", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "admin@example.test");
    sequence = 0;
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Payment Suite') returning id`;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash)
      values (${propertyId}, 'Payment Listing', 'encrypted', ${`hash-${propertyId}`}) returning id
    `;
    listingId = listing.id;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("confirms captured payment once, converts inventory, and creates one linked direct reservation", async () => {
    const booking = await addHeldBooking();
    const razorpay = fakeRazorpay([{ id: "pay_captured", status: "captured", amount: 1200000 }]);
    const service = createPaymentReconciliationService(testSql, { razorpay, clock: () => NOW });
    expect(await service.reconcileBooking(booking.public_reference, "client_callback")).toMatchObject({ status: "confirmed" });
    expect(await service.reconcileBooking(booking.public_reference, "webhook")).toMatchObject({ status: "confirmed" });
    expect(await bookingState(booking.id)).toMatchObject({ status: "confirmed", razorpay_payment_id: "pay_captured" });
    expect(await activeKinds()).toEqual([{ source_kind: "website_booking" }, { source_kind: "website_booking" }]);
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.local_calendar_entries where booking_id = ${booking.id}
    `;
    expect(count).toBe(1);
    const messages = await testSql<{ recipient_kind: string; template_key: string }[]>`
      select recipient_kind, template_key from public.notification_outbox where booking_id = ${booking.id} order by recipient_kind
    `;
    expect(messages).toEqual([
      { recipient_kind: "admin", template_key: "admin_new_booking" },
      { recipient_kind: "guest", template_key: "booking_confirmation" },
    ]);
  });

  it("deduplicates webhook event IDs and ignores an out-of-order authorization after capture", async () => {
    const booking = await addHeldBooking();
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([]), clock: () => NOW,
    });
    const captured = {
      eventType: "payment.captured" as const,
      orderId: "order_payment_1",
      paymentId: "pay_webhook_captured",
      paymentStatus: "captured",
      amountPaise: 1200000,
    };
    expect(await service.processWebhookEvent("event-captured", captured, "captured-body")).toMatchObject({ duplicate: false });
    expect(await service.processWebhookEvent("event-captured", captured, "captured-body")).toEqual({ duplicate: true });
    await service.processWebhookEvent("event-authorized-late", {
      ...captured,
      eventType: "payment.authorized",
      paymentStatus: "authorized",
    }, "authorized-body");

    expect(await bookingState(booking.id)).toMatchObject({ status: "confirmed", razorpay_payment_id: "pay_webhook_captured" });
    const [{ events, entries }] = await testSql<{ events: number; entries: number }[]>`
      select
        (select count(*)::int from public.payment_events) as events,
        (select count(*)::int from public.local_calendar_entries where booking_id = ${booking.id}) as entries
    `;
    expect({ events, entries }).toEqual({ events: 2, entries: 1 });
  });

  it("retains authorized inventory as payment pending without confirming", async () => {
    const booking = await addHeldBooking();
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([{ id: "pay_authorized", status: "authorized", amount: 1200000 }]), clock: () => NOW,
    });
    expect(await service.reconcileBooking(booking.public_reference, "hold_expiry")).toMatchObject({ status: "payment_pending" });
    expect(await activeKinds()).toEqual([{ source_kind: "website_hold" }, { source_kind: "website_hold" }]);
  });

  it("releases immediately for a definitive failed payment or verified dismissal with no attempt", async () => {
    const failed = await addHeldBooking();
    const failedService = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([{ id: "pay_failed", status: "failed", amount: 1200000 }]), clock: () => NOW,
    });
    expect(await failedService.reconcileBooking(failed.public_reference, "webhook")).toMatchObject({ status: "payment_failed" });
    expect(await activeKinds()).toEqual([]);

    const dismissed = await addHeldBooking();
    const dismissedService = createPaymentReconciliationService(testSql, { razorpay: fakeRazorpay([]), clock: () => NOW });
    expect(await dismissedService.reconcileBooking(dismissed.public_reference, "checkout_dismissed")).toMatchObject({ status: "expired" });
    expect(await activeKinds()).toEqual([]);
  });

  it("retains the hold on provider ambiguity", async () => {
    const booking = await addHeldBooking();
    const razorpay = { publicKeyId: "rzp_test_reconciliation", fetchOrderPayments: vi.fn(async () => { throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"); }) };
    const service = createPaymentReconciliationService(testSql, { razorpay, clock: () => NOW });
    await expect(service.reconcileBooking(booking.public_reference, "hold_expiry")).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_RETRYABLE" });
    expect(await bookingState(booking.id)).toMatchObject({ status: "held" });
    expect(await activeKinds()).toHaveLength(2);
  });

  it("never reclaims released inventory for a late capture and enqueues one refund job", async () => {
    const late = await addHeldBooking("expired");
    const actorId = "10000000-0000-4000-8000-000000000009";
    await testSql`insert into auth.users (id, email) values (${actorId}, 'late-block@example.test')`;
    await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
      await releaseSourceNights(tx, "website_hold", late.id, "hold_expired");
      const [manual] = await tx<{ id: string }[]>`
        insert into public.local_calendar_entries (
          property_id, listing_id, entry_type, start_date, end_date, sync_to_airbnb, created_by
        ) values (${propertyId}, ${listingId}, 'blocked', '2026-08-14', '2026-08-16', true, ${actorId})
        returning id
      `;
      await claimStayNights(tx, {
        propertyId,
        stayDates: ["2026-08-14", "2026-08-15"],
        sourceKind: "manual_local",
        sourceId: manual.id,
      });
    });
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([{ id: "pay_late", status: "captured", amount: 1200000 }]), clock: () => NOW,
    });
    await service.reconcileBooking(late.public_reference, "webhook");
    await service.reconcileBooking(late.public_reference, "webhook");
    expect(await bookingState(late.id)).toMatchObject({ status: "expired", refund_status: "pending" });
    expect(await activeKinds()).toEqual([{ source_kind: "manual_local" }, { source_kind: "manual_local" }]);
    const jobs = await testSql<{ idempotency_identity: string }[]>`select idempotency_identity from public.payment_jobs`;
    expect(jobs).toEqual([{ idempotency_identity: `refund:${late.id}` }]);
  });
});
