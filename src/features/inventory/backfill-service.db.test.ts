import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createSyncReconciliationService } from "@/features/sync/sync-service";
import { claimStayNights, createInventoryService } from "./inventory-service";
import { createBackfillService } from "./backfill-service";
import { recordPropertyShadowMismatches } from "./shadow-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
let propertyId: string;
let listingId: string;
let bookingSequence = 0;

async function addExternal(
  sourceUid: string,
  eventType: "reservation" | "unavailable" | "unknown",
  startDate: string,
  endDate: string,
) {
  const [event] = await testSql<{ id: string }[]>`
    insert into public.external_calendar_events (
      listing_id, source_uid, event_type, start_date, end_date, source_content_hash
    ) values (${listingId}, ${sourceUid}, ${eventType}, ${startDate}, ${endDate}, ${`hash-${sourceUid}`})
    returning id
  `;
  return event.id;
}

async function addManual(startDate: string, endDate: string) {
  const [entry] = await testSql<{ id: string }[]>`
    insert into public.local_calendar_entries (
      property_id, listing_id, entry_type, start_date, end_date, sync_to_airbnb, created_by
    ) values (${propertyId}, ${listingId}, 'blocked', ${startDate}, ${endDate}, true, ${USER_ID})
    returning id
  `;
  return entry.id;
}

async function addBooking(paid = false) {
  bookingSequence += 1;
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, amount_paise, razorpay_payment_id
    ) values (
      ${`NH-SYNCBOOK${String(bookingSequence).padStart(4, "0")}`}, ${propertyId},
      'Website Guest', 'website@example.test', '+919999999999', 1,
      '2026-08-14', '2026-08-16', 10000, ${paid ? `pay-${bookingSequence}` : null}
    ) returning id
  `;
  return booking.id;
}

async function activeNights() {
  return testSql<{ stay_date: string; source_kind: string; source_id: string }[]>`
    select stay_date::text, source_kind, source_id from public.inventory_nights
    where property_id = ${propertyId} and status = 'active'
    order by stay_date
  `;
}

const incoming = (
  sourceUid: string,
  eventType: "reservation" | "unavailable" | "unknown",
  startDate = "2026-08-14",
  endDate = "2026-08-16",
) => ({
  sourceUid,
  eventType,
  startDate,
  endDate,
  sanitizedReservationUrl: null,
  contentHash: `incoming-${sourceUid}`,
});

describe("inventory backfill and iCal application", () => {
  beforeEach(async () => {
    await resetDb();
    bookingSequence = 0;
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values ('Backfill Suite') returning id
    `;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (
        property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash
      ) values (${propertyId}, 'Backfill Listing', 'encrypted', ${`hash-${propertyId}`}) returning id
    `;
    listingId = listing.id;
  });

  it("backfills idempotently with reservation, manual, unavailable precedence", async () => {
    const reservationId = await addExternal("reservation", "reservation", "2026-08-14", "2026-08-15");
    const manualId = await addManual("2026-08-14", "2026-08-17");
    const unavailableId = await addExternal("unavailable", "unavailable", "2026-08-14", "2026-08-18");
    const backfill = createBackfillService(testSql);

    const first = await backfill.backfillInventory();
    const beforeSecond = await testSql<{ count: number }[]>`select count(*)::int as count from public.inventory_nights`;
    const second = await backfill.backfillInventory();
    const afterSecond = await testSql<{ count: number }[]>`select count(*)::int as count from public.inventory_nights`;

    expect(await activeNights()).toEqual([
      { stay_date: "2026-08-14", source_kind: "airbnb_reservation", source_id: reservationId },
      { stay_date: "2026-08-15", source_kind: "manual_local", source_id: manualId },
      { stay_date: "2026-08-16", source_kind: "manual_local", source_id: manualId },
      { stay_date: "2026-08-17", source_kind: "airbnb_unavailable", source_id: unavailableId },
    ]);
    expect(first).toMatchObject({ properties: 1, activeNights: 4 });
    expect(second).toMatchObject({ properties: 1, activeNights: 4 });
    expect(afterSecond[0].count).toBe(beforeSecond[0].count);
  });

  it("reports a newly imported Airbnb reservation collision with a website hold", async () => {
    const bookingId = await addBooking();
    const inventory = createInventoryService(testSql);
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: "website_hold",
      sourceId: bookingId,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }));

    const result = await createSyncReconciliationService(testSql, "enforced")
      .applyReconciliation(listingId, [incoming("airbnb-reservation", "reservation")], "2026-07-21");

    expect(result.collisions).toEqual([{ bookingId, stayDates: ["2026-08-14", "2026-08-15"] }]);
    expect((await activeNights()).every((night) => night.source_kind === "website_hold")).toBe(true);
  });

  it("lets unavailable inventory displace only an unpaid website hold", async () => {
    const unpaidBookingId = await addBooking();
    const inventory = createInventoryService(testSql);
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: "website_hold",
      sourceId: unpaidBookingId,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }));
    await createSyncReconciliationService(testSql, "enforced")
      .applyReconciliation(listingId, [incoming("airbnb-unavailable", "unknown")], "2026-07-21");
    expect((await activeNights()).every((night) => night.source_kind === "airbnb_unknown")).toBe(true);

    await resetDb();
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Paid Hold Suite') returning id`;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash)
      values (${propertyId}, 'Paid Hold Listing', 'encrypted', ${`hash-${propertyId}`}) returning id
    `;
    listingId = listing.id;
    const paidBookingId = await addBooking(true);
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: "website_hold",
      sourceId: paidBookingId,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }));
    await createSyncReconciliationService(testSql, "enforced")
      .applyReconciliation(listingId, [incoming("paid-unavailable", "unavailable")], "2026-07-21");
    expect((await activeNights()).every((night) => night.source_kind === "website_hold")).toBe(true);
  });

  it("promotes the next raw source when an imported winning event is archived", async () => {
    const reservationId = await addExternal("winner", "reservation", "2026-08-14", "2026-08-16");
    const manualId = await addManual("2026-08-14", "2026-08-16");
    await createBackfillService(testSql).backfillInventory();
    expect((await activeNights()).every((night) => night.source_id === reservationId)).toBe(true);

    await createSyncReconciliationService(testSql, "enforced")
      .applyReconciliation(listingId, [], "2026-07-21");

    expect((await activeNights()).every((night) => night.source_id === manualId)).toBe(true);
  });

  it("writes redacted audit rows for shadow occupancy mismatches", async () => {
    await addManual("2026-08-14", "2026-08-16");
    const inventory = createInventoryService(testSql);
    const count = await inventory.withPropertyInventory(propertyId, (tx) => recordPropertyShadowMismatches(
      tx,
      propertyId,
      "2026-08-14",
      "2026-08-16",
    ));

    expect(count).toBe(2);
    const [audit] = await testSql<{ changes: { mismatchCount: number; dates: string[] } }[]>`
      select changes from public.audit_log where action = 'inventory_shadow_mismatch'
    `;
    expect(audit.changes).toEqual({ mismatchCount: 2, dates: ["2026-08-14", "2026-08-15"] });
  });
});
