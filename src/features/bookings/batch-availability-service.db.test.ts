import { beforeEach, describe, expect, it } from "vitest";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { PUBLIC_ROOM_SLUGS } from "@/features/pricing/pricing-schema";
import { resetDb, testSql } from "@/test/db-test-client";
import { createBatchAvailabilityService } from "./batch-availability-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-21T10:00:00.000Z");
const request = {
  checkin: "2026-08-14",
  checkout: "2026-08-17",
  guests: 2,
};

const propertyIds = new Map<string, string>();

async function seedRooms() {
  await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
  for (const [index, slug] of PUBLIC_ROOM_SLUGS.entries()) {
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values (${`Room ${index + 1}`}) returning id
    `;
    propertyIds.set(slug, property.id);
    await testSql`
      insert into public.property_rates (
        property_id, public_room_slug, max_guests, weekday_price_paise,
        weekend_price_paise, booking_enabled, updated_by
      ) values (
        ${property.id}, ${slug}, ${slug === "sage-sunlight-studio" ? 1 : 4},
        500000, 700000, true, ${USER_ID}
      )
    `;
  }
  await testSql`
    insert into public.property_rate_overrides (property_id, stay_date, price_paise, updated_by)
    values (${propertyIds.get("shade-of-love")!}, '2026-08-15', 750000, ${USER_ID})
  `;

  const [privateProperty] = await testSql<{ id: string }[]>`
    insert into public.properties (name) values ('Private room') returning id
  `;
  await testSql`
    insert into public.property_rates (
      property_id, public_room_slug, max_guests, weekday_price_paise,
      weekend_price_paise, booking_enabled, updated_by
    ) values (${privateProperty.id}, 'private-room', 2, 500000, 700000, false, ${USER_ID})
  `;

  const occupiedPropertyId = propertyIds.get("ink-ivory-suite")!;
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, status, amount_paise
    ) values (
      'NH-BATCHOCCUPIED001', ${occupiedPropertyId}, 'Existing Guest',
      'existing@example.test', '+919999999999', 2,
      '2026-08-14', '2026-08-15', 'confirmed', 700000
    ) returning id
  `;
  await createInventoryService(testSql).withPropertyInventory(occupiedPropertyId, (tx) =>
    claimStayNights(tx, {
      propertyId: occupiedPropertyId,
      stayDates: ["2026-08-14"],
      sourceKind: "website_booking",
      sourceId: booking.id,
    }));
}

async function writeCounts() {
  const [row] = await testSql<{
    bookings: number;
    inventory: number;
    payments: number;
  }[]>`
    select
      (select count(*)::int from public.bookings) as bookings,
      (select count(*)::int from public.inventory_nights) as inventory,
      (select count(*)::int from public.payment_events) as payments
  `;
  return row;
}

describe("batch public availability", () => {
  beforeEach(async () => {
    await resetDb();
    propertyIds.clear();
    await seedRooms();
  });

  it("quotes all enabled rooms in canonical order with per-room availability", async () => {
    const service = createBatchAvailabilityService(testSql, { clock: () => NOW });
    const result = await service.quoteBatch(request);

    expect(result).toMatchObject({ ...request, currency: "INR" });
    expect(result.rooms.map((room) => room.publicRoomSlug)).toEqual(PUBLIC_ROOM_SLUGS);
    expect(new Set(result.rooms.map((room) => room.publicRoomSlug)).size).toBe(8);

    expect(result.rooms.find((room) => room.publicRoomSlug === "sage-sunlight-studio"))
      .toMatchObject({ available: false, unavailableReason: "capacity" });
    expect(result.rooms.find((room) => room.publicRoomSlug === "ink-ivory-suite"))
      .toMatchObject({ available: false, unavailableReason: "occupied" });
    expect(result.rooms.find((room) => room.publicRoomSlug === "shade-of-love"))
      .toMatchObject({
        available: true,
        unavailableReason: null,
        nights: [
          { date: "2026-08-14", amountPaise: 700000, source: "weekend" },
          { date: "2026-08-15", amountPaise: 750000, source: "override" },
          { date: "2026-08-16", amountPaise: 500000, source: "weekday" },
        ],
        totalPaise: 1950000,
      });
  });

  it("is read-only even for concurrent quotes", async () => {
    const service = createBatchAvailabilityService(testSql, { clock: () => NOW });
    const before = await writeCounts();
    const [first, second] = await Promise.all([
      service.quoteBatch(request),
      service.quoteBatch(request),
    ]);

    expect(first).toEqual(second);
    expect(await writeCounts()).toEqual(before);
  });
});
