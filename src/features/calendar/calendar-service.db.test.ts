import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createCalendarService } from "./calendar-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";

describe("booking states in the master schedule", () => {
  beforeEach(async () => {
    await resetDb();
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
  });

  it("uses the entered guest name as the label for a manual direct reservation", async () => {
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values ('Named Direct Suite') returning id
    `;
    await testSql`
      insert into public.local_calendar_entries (
        property_id, entry_type, start_date, end_date, private_booking_name, created_by
      ) values (
        ${property.id}, 'direct_reservation', '2026-08-14', '2026-08-16', 'Aarav Sharma', ${USER_ID}
      )
    `;

    const [room] = await createCalendarService(testSql).getCalendarData(USER_ID, "2026-08-14", 3);

    expect(room.entries).toHaveLength(1);
    expect(room.entries[0]).toMatchObject({
      source: "local",
      kind: "direct_reservation",
      label: "Aarav Sharma",
      privateBookingName: "Aarav Sharma",
    });
  });

  it("shows only active holds and confirmed public references, with failure alerts but no guest PII", async () => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Schedule Suite') returning id`;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash)
      values (${property.id}, 'Schedule Listing', 'encrypted', ${`hash-${property.id}`}) returning id
    `;
    const [hold] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id
      ) values (
        'NH-ACTIVEHOLD123', ${property.id}, 'Private Hold Guest', 'hold-private@example.test', '+919999999999', 2,
        '2026-08-14', '2026-08-16', 'payment_pending', '2099-08-14T10:10:00Z', 1200000, 'order_active_hold'
      ) returning id
    `;
    await testSql`
      insert into public.inventory_nights (
        property_id, stay_date, source_kind, source_id, booking_id, status, expires_at
      ) values
        (${property.id}, '2026-08-14', 'website_hold', ${hold.id}, ${hold.id}, 'active', '2099-08-14T10:10:00Z'),
        (${property.id}, '2026-08-15', 'website_hold', ${hold.id}, ${hold.id}, 'active', '2099-08-14T10:10:00Z')
    `;
    const [expired] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id
      ) values (
        'NH-EXPIREDHOLD12', ${property.id}, 'Expired Guest', 'expired@example.test', '+919999999999', 2,
        '2026-08-16', '2026-08-17', 'expired', '2026-07-20T10:10:00Z', 600000, 'order_expired_hold'
      ) returning id
    `;
    await testSql`
      insert into public.inventory_nights (
        property_id, stay_date, source_kind, source_id, booking_id, status, expires_at, released_at, release_reason
      ) values (${property.id}, '2026-08-16', 'website_hold', ${expired.id}, ${expired.id}, 'released', '2026-07-20T10:10:00Z', now(), 'expired')
    `;
    const [confirmed] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_order_id, razorpay_payment_id, confirmed_at
      ) values (
        'NH-CONFIRMED1234', ${property.id}, 'Private Confirmed Guest', 'confirmed-private@example.test', '+919999999999', 2,
        '2026-08-18', '2026-08-20', 'confirmed', 1300000, 'order_confirmed', 'pay_confirmed', now()
      ) returning id
    `;
    await testSql`
      insert into public.local_calendar_entries (
        property_id, listing_id, entry_type, start_date, end_date, private_booking_name,
        private_contact, sync_to_airbnb, booking_id, created_by
      ) values (
        ${property.id}, ${listing.id}, 'direct_reservation', '2026-08-18', '2026-08-20',
        'Private Confirmed Guest', 'confirmed-private@example.test', true, ${confirmed.id}, null
      )
    `;
    await testSql`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, cancellation_reason, refund_status, cancelled_at
      ) values (
        'NH-COLLISION12345', ${property.id}, 'Collision Guest', 'collision-private@example.test', '+919999999999', 2,
        '2026-08-17', '2026-08-18', 'cancelled', 600000, 'airbnb_collision', 'failed', now()
      )
    `;

    const [room] = await createCalendarService(testSql).getCalendarData(USER_ID, "2026-08-14", 7);

    expect(room.entries.map((entry) => ({ kind: entry.kind, label: entry.label }))).toEqual([
      { kind: "direct_reservation", label: "Website booking · NH-CONFIRMED1234" },
      { kind: "payment_hold", label: "Payment in progress" },
    ]);
    expect(room.alerts).toEqual([{ id: expect.any(String), severity: "error", message: "Refund failed for NH-COLLISION12345" }]);
    expect(JSON.stringify(room)).not.toMatch(/Private|@example\.test/);
    expect(room.entries.some((entry) => entry.id.includes(expired.id))).toBe(false);
  });
});
