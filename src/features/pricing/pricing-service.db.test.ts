import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { PUBLIC_ROOM_SLUGS } from "./pricing-schema";
import { createPricingService } from "./pricing-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const pricing = createPricingService(testSql);

async function createUser() {
  await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
}

async function createProperty(name: string) {
  const [property] = await testSql<{ id: string }[]>`
    insert into public.properties (name) values (${name}) returning id
  `;
  return property.id;
}

describe("pricing persistence", () => {
  beforeEach(async () => {
    await resetDb();
    await createUser();
  });

  it("maps all eight public slugs to exactly one complete active rate", async () => {
    for (const [index, slug] of PUBLIC_ROOM_SLUGS.entries()) {
      const propertyId = await createProperty(`Noir Haus Room ${index + 1}`);
      await pricing.saveBaseRates({
        propertyId,
        publicRoomSlug: slug,
        maxGuests: index % 2 === 0 ? 2 : 4,
        weekdayPricePaise: 500000 + index * 10000,
        weekendPricePaise: 650000 + index * 10000,
        bookingEnabled: true,
      }, USER_ID);
    }

    for (const slug of PUBLIC_ROOM_SLUGS) {
      const quote = await pricing.getQuoteForSlug({
        publicRoomSlug: slug,
        checkin: "2026-08-07",
        checkout: "2026-08-09",
        guests: 2,
      });
      expect(quote.propertyId).toMatch(/^[0-9a-f-]{36}$/);
      expect(quote.maxGuests).toBeGreaterThan(0);
      expect(quote.nights).toHaveLength(2);
      expect(quote.nights.every((night) => night.amountPaise > 0)).toBe(true);
      expect(quote.totalPaise).toBeGreaterThan(0);
    }

    const rows = await pricing.listPricingForUser(USER_ID);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.publicRoomSlug)).size).toBe(8);
  });

  it("will not quote unmapped, disabled, inactive, incomplete, or over-capacity inventory", async () => {
    await expect(pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-07",
      checkout: "2026-08-08",
      guests: 1,
    })).rejects.toThrow("NOT_BOOKABLE");

    const propertyId = await createProperty("Disabled Room");
    await pricing.saveBaseRates({
      propertyId,
      publicRoomSlug: "shade-of-love",
      maxGuests: 2,
      weekdayPricePaise: 500000,
      weekendPricePaise: 650000,
      bookingEnabled: false,
    }, USER_ID);
    await expect(pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-07",
      checkout: "2026-08-08",
      guests: 1,
    })).rejects.toThrow("NOT_BOOKABLE");

    await pricing.saveBaseRates({
      propertyId,
      publicRoomSlug: "shade-of-love",
      maxGuests: 2,
      weekdayPricePaise: 500000,
      weekendPricePaise: 650000,
      bookingEnabled: true,
    }, USER_ID);
    await expect(pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-07",
      checkout: "2026-08-08",
      guests: 3,
    })).rejects.toThrow("CAPACITY_EXCEEDED");

    await testSql`update public.properties set active = false where id = ${propertyId}`;
    await expect(pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-07",
      checkout: "2026-08-08",
      guests: 1,
    })).rejects.toThrow("NOT_BOOKABLE");

    const incompletePropertyId = await createProperty("Incomplete Room");
    await expect(testSql`
      insert into public.property_rates (
        property_id, public_room_slug, max_guests, weekday_price_paise,
        booking_enabled, updated_by
      ) values (
        ${incompletePropertyId}, 'ink-ivory-suite', 2, 500000, true, ${USER_ID}
      )
    `).rejects.toBeDefined();
  });

  it("saves and clears date overrides with an audit trail", async () => {
    const propertyId = await createProperty("Override Room");
    await pricing.saveBaseRates({
      propertyId,
      publicRoomSlug: "shade-of-love",
      maxGuests: 2,
      weekdayPricePaise: 500000,
      weekendPricePaise: 650000,
      bookingEnabled: true,
    }, USER_ID);
    await pricing.saveDateOverride({ propertyId, stayDate: "2026-08-08", pricePaise: 725000 }, USER_ID);

    const quote = await pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-08",
      checkout: "2026-08-09",
      guests: 2,
    });
    expect(quote.nights[0]).toMatchObject({ amountPaise: 725000, source: "override" });

    await pricing.clearDateOverride({ propertyId, stayDate: "2026-08-08" }, USER_ID);
    const afterClear = await pricing.getQuoteForSlug({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-08",
      checkout: "2026-08-09",
      guests: 2,
    });
    expect(afterClear.nights[0]).toMatchObject({ amountPaise: 650000, source: "weekend" });

    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log where property_id = ${propertyId}
    `;
    expect(count).toBe(3);
  });

  it("requires property membership for every admin mutation", async () => {
    const propertyId = await createProperty("Private Room");
    await testSql`delete from public.property_members where property_id = ${propertyId} and user_id = ${USER_ID}`;
    await expect(pricing.saveBaseRates({
      propertyId,
      publicRoomSlug: "shade-of-love",
      maxGuests: 2,
      weekdayPricePaise: 500000,
      weekendPricePaise: 650000,
      bookingEnabled: true,
    }, USER_ID)).rejects.toThrow("FORBIDDEN");
  });
});
