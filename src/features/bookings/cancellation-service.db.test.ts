import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createSyncReconciliationService } from "@/features/sync/sync-service";
import { cancelWebsiteBookingForAirbnbCollision } from "./cancellation-service";
import { createPaymentReconciliationService } from "@/features/payments/payment-reconciliation";
import { createRefundService } from "@/features/payments/refund-service";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
let propertyId: string;
let listingId: string;
let bookingSequence = 0;
const RAZORPAY_KEY_ID = "rzp_test_collision";

async function addBooking(confirmed: boolean) {
  bookingSequence += 1;
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
      checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id, razorpay_payment_id,
      razorpay_key_id, confirmed_at
    ) values (
      ${`NH-COLLISION${String(bookingSequence).padStart(3, "0")}`}, ${propertyId}, 'Collision Guest',
      'collision@example.test', '+919999999999', 2, '2026-08-14', '2026-08-16',
      ${confirmed ? "confirmed" : "held"}, '2099-01-01', 1200000, ${`order_collision_${bookingSequence}`},
      ${confirmed ? `pay_collision_${bookingSequence}` : null}, ${RAZORPAY_KEY_ID},
      ${confirmed ? new Date("2026-07-21T10:00:00Z") : null}
    ) returning id
  `;
  await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
    await claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: confirmed ? "website_booking" : "website_hold",
      sourceId: booking.id,
      ...(confirmed ? {} : { expiresAt: new Date("2099-01-01T00:00:00Z") }),
    } as Parameters<typeof claimStayNights>[1]);
    if (confirmed) await tx`
      insert into public.local_calendar_entries (
        property_id, listing_id, entry_type, start_date, end_date, private_booking_name,
        sync_to_airbnb, booking_id, created_by
      ) values (${propertyId}, ${listingId}, 'direct_reservation', '2026-08-14', '2026-08-16',
        'Collision Guest', true, ${booking.id}, null)
    `;
  });
  return booking.id;
}

async function addExternal(eventType: "reservation" | "unavailable" | "unknown", uid: string = eventType) {
  const [event] = await testSql<{ id: string }[]>`
    insert into public.external_calendar_events (
      listing_id, source_uid, event_type, start_date, end_date, source_content_hash
    ) values (${listingId}, ${uid}, ${eventType}, '2026-08-14', '2026-08-16', ${`hash-${uid}`})
    returning id
  `;
  return event.id;
}

describe("Airbnb-wins collision cancellation", () => {
  beforeEach(async () => {
    await resetDb();
    bookingSequence = 0;
    vi.stubEnv("ADMIN_NOTIFICATION_EMAIL", "admin@example.test");
    await testSql`insert into auth.users (id, email) values (${ACTOR_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Collision Suite') returning id`;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash)
      values (${propertyId}, 'Collision Listing', 'encrypted', ${`hash-${propertyId}`}) returning id
    `;
    listingId = listing.id;
  });

  it("atomically cancels, releases, promotes Airbnb, archives local entry, and queues refund plus alerts", async () => {
    const bookingId = await addBooking(true);
    const externalEventId = await addExternal("reservation");
    await createInventoryService(testSql).withPropertyInventory(propertyId, (tx) => (
      cancelWebsiteBookingForAirbnbCollision(tx, bookingId, externalEventId)
    ));

    const [booking] = await testSql<{ status: string; cancellation_reason: string; refund_status: string }[]>`
      select status, cancellation_reason, refund_status from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({ status: "cancelled", cancellation_reason: "airbnb_collision", refund_status: "pending" });
    const owners = await testSql<{ source_kind: string }[]>`
      select source_kind from public.inventory_nights where property_id = ${propertyId} and status = 'active' order by stay_date
    `;
    expect(owners).toEqual([{ source_kind: "airbnb_reservation" }, { source_kind: "airbnb_reservation" }]);
    const [entry] = await testSql<{ active: boolean }[]>`select active from public.local_calendar_entries where booking_id = ${bookingId}`;
    expect(entry.active).toBe(false);
    const reconciliation = createPaymentReconciliationService(testSql, {
      razorpay: {
        publicKeyId: RAZORPAY_KEY_ID,
        fetchOrderPayments: async () => [{ id: "pay_collision_1", status: "captured", amount: 1200000 }],
      },
    });
    await reconciliation.applyVerifiedPayment("order_collision_1", { id: "pay_collision_1", status: "captured", amount: 1200000 });
    const jobs = await testSql<{ idempotency_identity: string }[]>`
      select idempotency_identity from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'
    `;
    expect(jobs).toEqual([{ idempotency_identity: `refund:${bookingId}` }]);
    const provider = {
      publicKeyId: RAZORPAY_KEY_ID,
      fetchOrderPayments: vi.fn(async () => [{ id: "pay_collision_1", status: "captured", amount: 1200000 }]),
      findRefund: vi.fn(async () => null),
      createFullRefund: vi.fn(async () => ({ id: "rfnd_collision_1", status: "processed" as const })),
    };
    await createRefundService(testSql, { provider }).processBatch(10);
    await createRefundService(testSql, { provider }).processBatch(10);
    expect(provider.createFullRefund).toHaveBeenCalledOnce();
    expect(await testSql`select id from public.notification_outbox where booking_id = ${bookingId}`).toHaveLength(3);
    expect(await testSql`select id from public.audit_log where entity_id = ${bookingId} and action = 'airbnb_collision'`).toHaveLength(1);
  });

  it("cancels an unpaid hold without creating a refund and stays idempotent", async () => {
    const bookingId = await addBooking(false);
    const externalEventId = await addExternal("reservation", "unpaid-reservation");
    const inventory = createInventoryService(testSql);
    await inventory.withPropertyInventory(propertyId, (tx) => cancelWebsiteBookingForAirbnbCollision(tx, bookingId, externalEventId));
    await inventory.withPropertyInventory(propertyId, (tx) => cancelWebsiteBookingForAirbnbCollision(tx, bookingId, externalEventId));
    expect(await testSql`select id from public.payment_jobs where booking_id = ${bookingId}`).toHaveLength(0);
    expect(await testSql`select id from public.notification_outbox where booking_id = ${bookingId}`).toHaveLength(2);
  });

  it("wires genuine reservation collisions through sync while unavailable remains alert-only", async () => {
    const bookingId = await addBooking(true);
    const sync = createSyncReconciliationService(testSql, "enforced");
    await sync.applyReconciliation(listingId, [{
      sourceUid: "sync-reservation",
      eventType: "reservation",
      startDate: "2026-08-14",
      endDate: "2026-08-16",
      sanitizedReservationUrl: null,
      contentHash: "sync-reservation-hash",
    }], "2026-07-21");
    const [cancelled] = await testSql<{ status: string }[]>`select status from public.bookings where id = ${bookingId}`;
    expect(cancelled.status).toBe("cancelled");

    await resetDb();
    await testSql`insert into auth.users (id, email) values (${ACTOR_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Alert Suite') returning id`;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash)
      values (${propertyId}, 'Alert Listing', 'encrypted', ${`hash-alert-${propertyId}`}) returning id
    `;
    listingId = listing.id;
    const alertBookingId = await addBooking(true);
    await createSyncReconciliationService(testSql, "enforced").applyReconciliation(listingId, [{
      sourceUid: "sync-unavailable",
      eventType: "unavailable",
      startDate: "2026-08-14",
      endDate: "2026-08-16",
      sanitizedReservationUrl: null,
      contentHash: "sync-unavailable-hash",
    }], "2026-07-21");
    const [alertBooking] = await testSql<{ status: string }[]>`select status from public.bookings where id = ${alertBookingId}`;
    expect(alertBooking.status).toBe("confirmed");
    expect(await testSql`select id from public.audit_log where action = 'airbnb_calendar_block_overlaps_confirmed_booking'`).toHaveLength(1);
  });
});
