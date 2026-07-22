import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createAdminBookingService } from "./admin-booking-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";

async function insertBooking(propertyId: string, reference: string, guestName: string, guestEmail: string) {
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
      checkin, checkout, status, amount_paise, razorpay_order_id, razorpay_payment_id,
      confirmed_at
    ) values (
      ${reference}, ${propertyId}, ${guestName}, ${guestEmail}, '+919999999999', 2,
      '2026-08-14', '2026-08-16', 'confirmed', 1250000,
      ${`order-${reference}`}, ${`pay-${reference}`}, '2026-07-21T10:02:00Z'
    ) returning id
  `;
  await testSql`
    insert into public.booking_night_prices (booking_id, stay_date, price_paise, price_source)
    values (${booking.id}, '2026-08-14', 600000, 'weekday'), (${booking.id}, '2026-08-15', 650000, 'weekend')
  `;
  await testSql`
    insert into public.booking_events (property_id, booking_id, event_type, metadata)
    values (${propertyId}, ${booking.id}, 'booking_confirmed', '{"provider":"razorpay"}')
  `;
  await testSql`
    insert into public.notification_outbox (
      booking_id, recipient_kind, recipient_email, template_key, deduplication_key,
      subject, html_body, text_body, status, provider_message_id
    ) values (
      ${booking.id}, 'guest', ${guestEmail}, 'booking_confirmation_guest', ${`notice-${reference}`},
      'Confirmed', '<p>Confirmed</p>', 'Confirmed', 'sent', ${`message-${reference}`}
    )
  `;
  return booking.id;
}

describe("admin booking reads", () => {
  beforeEach(async () => {
    await resetDb();
    await testSql`
      insert into auth.users (id, email) values
        (${USER_ID}, 'owner@example.test'), (${OTHER_USER_ID}, 'other@example.test')
    `;
  });

  it("filters by property membership and returns immutable booking detail", async () => {
    const [visible] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Shade of Love') returning id`;
    const [hidden] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Hidden Suite') returning id`;
    await testSql`delete from public.property_members where property_id = ${hidden.id}`;
    await testSql`insert into public.property_members (property_id, user_id, role) values (${hidden.id}, ${OTHER_USER_ID}, 'owner')`;
    await insertBooking(visible.id, "NH-VISIBLE123456", "Riya Sharma", "riya@example.test");
    await insertBooking(hidden.id, "NH-HIDDEN123456", "Hidden Guest", "hidden@example.test");

    const rows = await createAdminBookingService(testSql).listBookingsForUser(USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publicReference: "NH-VISIBLE123456",
      propertyName: "Shade of Love",
      nights: [
        { stayDate: "2026-08-14", pricePaise: 600000, priceSource: "weekday" },
        { stayDate: "2026-08-15", pricePaise: 650000, priceSource: "weekend" },
      ],
      notifications: [{ templateKey: "booking_confirmation_guest", status: "sent", providerMessageId: "message-NH-VISIBLE123456" }],
      events: [{ eventType: "booking_confirmed", metadata: { provider: "razorpay" } }],
    });
  });

  it.each([
    ["visible123", "NH-VISIBLE123456"],
    ["riya", "NH-VISIBLE123456"],
    ["RIYA@EXAMPLE.TEST", "NH-VISIBLE123456"],
  ])("searches reference, guest name, or email with %s", async (search, expected) => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Search Suite') returning id`;
    await insertBooking(property.id, "NH-VISIBLE123456", "Riya Sharma", "riya@example.test");
    await insertBooking(property.id, "NH-OTHER12345678", "Other Guest", "other@example.test");

    const rows = await createAdminBookingService(testSql).listBookingsForUser(USER_ID, search);
    expect(rows.map((row) => row.publicReference)).toEqual([expected]);
  });

  it("hides archived bookings by default and supports archived/all views", async () => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Archive Suite') returning id`;
    await insertBooking(property.id, "NH-ACTIVE1234567", "Active Guest", "active@example.test");
    const archivedId = await insertBooking(property.id, "NH-ARCHIVE123456", "Archived Guest", "archived@example.test");
    await testSql`update public.bookings set status = 'cancelled', cancellation_reason = 'admin_refund', archived_at = now(), archived_by = ${USER_ID} where id = ${archivedId}`;

    const service = createAdminBookingService(testSql);
    expect((await service.listBookingsForUser(USER_ID)).map((row) => row.publicReference)).toEqual(["NH-ACTIVE1234567"]);
    expect((await service.listBookingsForUser(USER_ID, undefined, "archived")).map((row) => row.publicReference)).toEqual(["NH-ARCHIVE123456"]);
    expect(await service.listBookingsForUser(USER_ID, undefined, "all")).toHaveLength(2);
  });
});
