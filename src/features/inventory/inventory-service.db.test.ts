import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { expandStayDates } from "./date-range";
import {
  claimStayNights,
  createInventoryService,
  reconcilePropertyNights,
  releaseExpiredHolds,
  releaseSourceNights,
} from "./inventory-service";

const inventory = createInventoryService(testSql);
let referenceSequence = 0;

async function createProperty(name: string) {
  const [property] = await testSql<{ id: string }[]>`
    insert into public.properties (name) values (${name}) returning id
  `;
  return property.id;
}

async function createBooking(propertyId: string, checkin = "2026-08-14", checkout = "2026-08-18") {
  referenceSequence += 1;
  const reference = `NH-INVENTORY${String(referenceSequence).padStart(3, "0")}`;
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, amount_paise
    ) values (
      ${reference}, ${propertyId}, 'Inventory Guest', 'guest@example.test',
      '+919999999999', 1, ${checkin}, ${checkout}, 10000
    ) returning id
  `;
  return booking.id;
}

async function activeOwners(propertyId: string, stayDate: string) {
  const [{ count }] = await testSql<{ count: number }[]>`
    select count(*)::int as count from public.inventory_nights
    where property_id = ${propertyId} and stay_date = ${stayDate} and status = 'active'
  `;
  return count;
}

async function activeNightsForSource(sourceId: string) {
  const rows = await testSql<{ stay_date: string }[]>`
    select stay_date::text from public.inventory_nights
    where source_id = ${sourceId} and status = 'active' order by stay_date
  `;
  return rows.map((row) => row.stay_date);
}

describe("serialized nightly inventory", () => {
  beforeEach(async () => {
    await resetDb();
    referenceSequence = 0;
  });

  it("allows exactly one of two simultaneous claims for the same property night", async () => {
    const propertyId = await createProperty("Concurrent Suite");
    const firstBookingId = await createBooking(propertyId);
    const secondBookingId = await createBooking(propertyId);
    const first = inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14"],
      sourceKind: "website_booking",
      sourceId: firstBookingId,
    }));
    const second = inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14"],
      sourceKind: "website_booking",
      sourceId: secondBookingId,
    }));

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ message: "INVENTORY_UNAVAILABLE" }),
    });
    expect(await activeOwners(propertyId, "2026-08-14")).toBe(1);
  });

  it("claims a multi-night stay all-or-nothing", async () => {
    const propertyId = await createProperty("Atomic Suite");
    const existingBookingId = await createBooking(propertyId);
    const attemptedBookingId = await createBooking(propertyId);
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-15"],
      sourceKind: "website_booking",
      sourceId: existingBookingId,
    }));

    await expect(inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: expandStayDates("2026-08-14", "2026-08-17"),
      sourceKind: "website_booking",
      sourceId: attemptedBookingId,
    }))).rejects.toThrow("INVENTORY_UNAVAILABLE");

    expect(await activeNightsForSource(attemptedBookingId)).toEqual([]);
    expect(await activeNightsForSource(existingBookingId)).toEqual(["2026-08-15"]);
  });

  it("reclaims released nights for a later source", async () => {
    const propertyId = await createProperty("Reclaimable Suite");
    const firstBookingId = await createBooking(propertyId);
    const nextBookingId = await createBooking(propertyId);
    await inventory.withPropertyInventory(propertyId, async (tx) => {
      await claimStayNights(tx, { propertyId, stayDates: ["2026-08-14"], sourceKind: "website_booking", sourceId: firstBookingId });
      expect(await releaseSourceNights(tx, "website_booking", firstBookingId, "cancelled")).toBe(1);
      await claimStayNights(tx, { propertyId, stayDates: ["2026-08-14"], sourceKind: "website_booking", sourceId: nextBookingId });
    });

    expect(await activeNightsForSource(firstBookingId)).toEqual([]);
    expect(await activeNightsForSource(nextBookingId)).toEqual(["2026-08-14"]);
  });

  it("releases expired holds under the lock before a replacement claim", async () => {
    const propertyId = await createProperty("Expiry Suite");
    const expiredBookingId = await createBooking(propertyId);
    const nextBookingId = await createBooking(propertyId);
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14"],
      sourceKind: "website_hold",
      sourceId: expiredBookingId,
      expiresAt: new Date("2026-08-14T10:00:00.000Z"),
    }));

    await inventory.withPropertyInventory(propertyId, async (tx) => {
      expect(await releaseExpiredHolds(tx, propertyId, new Date("2026-08-14T10:01:00.000Z"))).toBe(1);
      await claimStayNights(tx, { propertyId, stayDates: ["2026-08-14"], sourceKind: "website_booking", sourceId: nextBookingId });
    });

    expect(await activeNightsForSource(expiredBookingId)).toEqual([]);
    expect(await activeNightsForSource(nextBookingId)).toEqual(["2026-08-14"]);
  });

  it("allows separate properties to claim the same date", async () => {
    const firstPropertyId = await createProperty("North Suite");
    const secondPropertyId = await createProperty("South Suite");
    const firstBookingId = await createBooking(firstPropertyId);
    const secondBookingId = await createBooking(secondPropertyId);

    const results = await Promise.all([
      inventory.withPropertyInventory(firstPropertyId, (tx) => claimStayNights(tx, { propertyId: firstPropertyId, stayDates: ["2026-08-14"], sourceKind: "website_booking", sourceId: firstBookingId })),
      inventory.withPropertyInventory(secondPropertyId, (tx) => claimStayNights(tx, { propertyId: secondPropertyId, stayDates: ["2026-08-14"], sourceKind: "website_booking", sourceId: secondBookingId })),
    ]);

    expect(results).toHaveLength(2);
    expect(await activeOwners(firstPropertyId, "2026-08-14")).toBe(1);
    expect(await activeOwners(secondPropertyId, "2026-08-14")).toBe(1);
  });

  it("rejects a claim for a property other than the one locked by the transaction", async () => {
    const lockedPropertyId = await createProperty("Locked Suite");
    const otherPropertyId = await createProperty("Other Suite");
    const bookingId = await createBooking(otherPropertyId);

    await expect(inventory.withPropertyInventory(lockedPropertyId, (tx) => claimStayNights(tx, {
      propertyId: otherPropertyId,
      stayDates: ["2026-08-14"],
      sourceKind: "website_booking",
      sourceId: bookingId,
    }))).rejects.toThrow("INVENTORY_LOCK_MISMATCH");

    expect(await activeOwners(otherPropertyId, "2026-08-14")).toBe(0);
  });

  it("reconciliation releases claims whose source is no longer active", async () => {
    const propertyId = await createProperty("Reconcile Suite");
    const bookingId = await createBooking(propertyId, "2026-08-14", "2026-08-16");
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: expandStayDates("2026-08-14", "2026-08-16"),
      sourceKind: "website_booking",
      sourceId: bookingId,
    }));
    await testSql`update public.bookings set status = 'cancelled', cancelled_at = now() where id = ${bookingId}`;

    const released = await inventory.withPropertyInventory(propertyId, (tx) => reconcilePropertyNights(
      tx,
      propertyId,
      "2026-08-14",
      "2026-08-16",
    ));

    expect(released).toBe(2);
    expect(await activeNightsForSource(bookingId)).toEqual([]);
  });
});
