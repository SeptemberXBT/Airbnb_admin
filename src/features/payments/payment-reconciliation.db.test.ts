import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import { orderReceipt } from "./order-recovery";
import { createPaymentReconciliationService } from "./payment-reconciliation";
import { RazorpayClientError, type RazorpayOrder, type RazorpayPayment } from "./razorpay-client";
import { parseRazorpayWebhook, verifyRazorpayWebhookSignature } from "./razorpay-webhook";
import { createBookingResumeService } from "@/features/bookings/booking-resume-service";

const NOW = new Date("2026-07-21T10:15:00.000Z");
const RESUME_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64url");
let sequence = 0;
let propertyId: string;
let listingId: string;

function referenceForOrder(orderId: string) {
  const sequenceNumber = Number(orderId.match(/(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) throw new Error("INVALID_TEST_ORDER");
  return `NH-PAYMENTTEST${String(sequenceNumber).padStart(3, "0")}`;
}

function fakeRazorpay(
  payments: RazorpayPayment[],
  orderOverrides: Partial<RazorpayOrder> = {},
) {
  return {
    publicKeyId: "rzp_test_reconciliation",
    fetchOrder: vi.fn(async (orderId: string): Promise<RazorpayOrder> => ({
      id: orderId,
      amount: 1200000,
      currency: "INR",
      receipt: orderReceipt(referenceForOrder(orderId)),
      status: "paid",
      ...orderOverrides,
    })),
    fetchOrderPayments: vi.fn(async () => payments),
  };
}

async function addHeldBooking(status = "held", expiresAt = new Date("2026-07-21T10:10:00.000Z")) {
  sequence += 1;
  const [booking] = await testSql<{ id: string; public_reference: string; razorpay_order_id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
      checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id
    ) values (
      ${`NH-PAYMENTTEST${String(sequence).padStart(3, "0")}`}, ${propertyId}, 'Payment Guest',
      'payment@example.test', '+919999999999', 2, '2026-08-14', '2026-08-16',
      ${status}, ${expiresAt}, 1200000, ${`order_payment_${sequence}`}
    ) returning id, public_reference, razorpay_order_id
  `;
  await testSql`
    insert into public.booking_night_prices (booking_id, stay_date, price_paise, price_source)
    values
      (${booking.id}, '2026-08-14', 600000, 'weekday'),
      (${booking.id}, '2026-08-15', 600000, 'weekday')
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
    const messages = await testSql<{
      recipient_kind: string;
      template_key: string;
      subject: string;
      html_body: string;
      text_body: string;
    }[]>`
      select recipient_kind, template_key, subject, html_body, text_body
      from public.notification_outbox where booking_id = ${booking.id} order by recipient_kind
    `;
    expect(messages.map(({ recipient_kind, template_key }) => ({ recipient_kind, template_key }))).toEqual([
      { recipient_kind: "admin", template_key: "admin_new_booking" },
      { recipient_kind: "guest", template_key: "booking_confirmation" },
    ]);
    const guestMessage = messages.find((message) => message.recipient_kind === "guest");
    expect(guestMessage).toMatchObject({
      subject: `Your Noir Haus booking is confirmed — ${booking.public_reference}`,
    });
    expect(guestMessage?.html_body).toContain("Payment Suite");
    expect(guestMessage?.html_body).toContain("2 guests");
    expect(guestMessage?.html_body).toContain("1:00 PM");
    expect(guestMessage?.html_body).toContain("11:00 AM");
    expect(guestMessage?.html_body).toContain("pay_captured");
    expect(guestMessage?.html_body).toContain("hello@noirhaus.in");
    expect(guestMessage?.text_body).toContain("PAYMENT STATUS: Paid");
  });

  it("deduplicates webhook event IDs and ignores an out-of-order authorization after capture", async () => {
    const booking = await addHeldBooking();
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([{
        id: "pay_webhook_captured", status: "captured", amount: 1200000,
      }]),
      clock: () => NOW,
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

  it("refuses a correctly signed captured webhook when the booking amount disagrees with immutable nightly prices", async () => {
    const booking = await addHeldBooking();
    await testSql`update public.bookings set amount_paise = 1 where id = ${booking.id}`;
    const razorpay = fakeRazorpay(
      [{ id: "pay_integrity_attack", status: "captured", amount: 1 }],
      { amount: 1, receipt: orderReceipt(booking.public_reference) },
    );
    const service = createPaymentReconciliationService(testSql, { razorpay, clock: () => NOW });
    const secret = "signed_integrity_webhook_secret";
    const rawBody = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_integrity_attack",
            order_id: booking.razorpay_order_id,
            status: "captured",
            amount: 1,
          },
        },
      },
    });
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyRazorpayWebhookSignature(rawBody, signature, secret)).toBe(true);
    const parsed = parseRazorpayWebhook(rawBody);

    await expect(service.processWebhookEvent("event-integrity-1", parsed, rawBody)).resolves.toMatchObject({
      duplicate: false,
      integrityFailure: true,
    });
    await testSql`
      update public.booking_night_prices set price_paise = 500000
      where booking_id = ${booking.id} and stay_date = '2026-08-15'
    `;
    await expect(service.processWebhookEvent("event-integrity-2", parsed, rawBody)).resolves.toMatchObject({
      duplicate: false,
      integrityFailure: true,
    });

    expect(await bookingState(booking.id)).toMatchObject({
      status: "held",
      razorpay_payment_id: null,
    });
    expect(razorpay.fetchOrder).toHaveBeenCalledTimes(2);
    expect(razorpay.fetchOrderPayments).toHaveBeenCalledTimes(2);
    expect(razorpay.fetchOrder).toHaveBeenNthCalledWith(1, booking.razorpay_order_id);
    expect(razorpay.fetchOrder).toHaveBeenNthCalledWith(2, booking.razorpay_order_id);
    const integrityEvents = await testSql<{ event_type: string; metadata: Record<string, unknown> }[]>`
      select event_type, metadata from public.booking_events
      where booking_id = ${booking.id} and event_type = 'AMOUNT_INTEGRITY_FAILURE'
      order by id
    `;
    expect(integrityEvents).toHaveLength(2);
    expect(integrityEvents[0]?.metadata).toMatchObject({
      paymentAmountPaise: 1,
      orderAmountPaise: 1,
      bookingAmountPaise: 1,
      nightlyTotalPaise: 1200000,
    });
    expect(integrityEvents[1]?.metadata).toMatchObject({
      paymentAmountPaise: 1,
      orderAmountPaise: 1,
      bookingAmountPaise: 1,
      nightlyTotalPaise: 1100000,
    });
    expect(await testSql`
      select id from public.notification_outbox
      where booking_id = ${booking.id} and template_key = 'amount_integrity_failure'
    `).toHaveLength(1);
    expect(await testSql`
      select status, error_code from public.payment_events
      where razorpay_event_id in ('event-integrity-1', 'event-integrity-2')
      order by razorpay_event_id
    `).toEqual([
      { status: "ignored", error_code: "amount_integrity_failure" },
      { status: "ignored", error_code: "amount_integrity_failure" },
    ]);
    const unavailableService = createPaymentReconciliationService(testSql, {
      razorpay: {
        publicKeyId: "rzp_test_reconciliation",
        fetchOrder: vi.fn(async () => { throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"); }),
        fetchOrderPayments: vi.fn(async () => { throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"); }),
      },
      clock: () => NOW,
    });
    await expect(unavailableService.reconcileBooking(booking.public_reference, "worker"))
      .rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_RETRYABLE" });
    expect(await testSql`
      select status, last_error_code from public.payment_jobs
      where booking_id = ${booking.id} and job_kind = 'payment_reconciliation'
    `).toEqual([{
      status: "definitive_failure",
      last_error_code: "amount_integrity_failure",
    }]);
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

  it("keeps a no-payment hold intact for a resume check", async () => {
    const booking = await addHeldBooking(
      "held",
      new Date("2026-07-21T10:20:00.000Z"),
    );
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([]),
      clock: () => NOW,
    });

    await expect(
      service.reconcileBooking(booking.public_reference, "resume"),
    ).resolves.toMatchObject({ status: "held" });
    expect(await activeKinds()).toHaveLength(2);
  });

  it("revokes the resume token after provider-verified dismissal releases inventory", async () => {
    const booking = await addHeldBooking(
      "held",
      new Date("2026-07-21T10:20:00.000Z"),
    );
    const resumeTokens = createBookingResumeService(testSql, {
      encryptionKey: RESUME_ENCRYPTION_KEY,
      clock: () => NOW,
    });
    const token = await resumeTokens.issue(
      booking.id,
      new Date("2026-07-21T10:20:00.000Z"),
    );
    const service = createPaymentReconciliationService(testSql, {
      razorpay: fakeRazorpay([]),
      clock: () => NOW,
    });

    await expect(
      service.reconcileBooking(booking.public_reference, "checkout_dismissed"),
    ).resolves.toMatchObject({ status: "expired" });
    await expect(
      resumeTokens.authorize(booking.public_reference, token, NOW),
    ).rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_REVOKED" });
    expect(await activeKinds()).toEqual([]);
  });

  it("retains the hold on provider ambiguity", async () => {
    const booking = await addHeldBooking();
    const razorpay = {
      publicKeyId: "rzp_test_reconciliation",
      fetchOrder: vi.fn(async () => { throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"); }),
      fetchOrderPayments: vi.fn(async () => { throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"); }),
    };
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
