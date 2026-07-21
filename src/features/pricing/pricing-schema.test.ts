import { describe, expect, it } from "vitest";
import {
  PUBLIC_ROOM_SLUGS,
  baseRateBatchSchema,
  baseRateInputSchema,
  createQuoteRequestSchema,
} from "./pricing-schema";

const validRate = {
  propertyId: "10000000-0000-4000-8000-000000000001",
  publicRoomSlug: PUBLIC_ROOM_SLUGS[0],
  maxGuests: 2,
  weekdayPricePaise: 500000,
  weekendPricePaise: 650000,
  bookingEnabled: true,
};

describe("pricing schemas", () => {
  it.each([0, -1])("rejects a non-positive weekday rate of %s paise", (amount) => {
    expect(baseRateInputSchema.safeParse({ ...validRate, weekdayPricePaise: amount }).success).toBe(false);
  });

  it.each([0, -100])("rejects a non-positive weekend rate of %s paise", (amount) => {
    expect(baseRateInputSchema.safeParse({ ...validRate, weekendPricePaise: amount }).success).toBe(false);
  });

  it("rejects malformed and duplicate public room slugs", () => {
    expect(baseRateInputSchema.safeParse({ ...validRate, publicRoomSlug: "Shade Of Love" }).success).toBe(false);
    expect(baseRateBatchSchema.safeParse({ rates: [validRate, { ...validRate }] }).success).toBe(false);
  });

  it("rejects guest counts over the property's capacity", () => {
    const schema = createQuoteRequestSchema(2);
    expect(schema.safeParse({
      publicRoomSlug: "shade-of-love",
      checkin: "2026-08-07",
      checkout: "2026-08-09",
      guests: 3,
    }).success).toBe(false);
  });

  it.each(["amount", "price", "currency", "discount", "tax", "fee"])(
    "rejects the client-controlled money field %s",
    (field) => {
      const schema = createQuoteRequestSchema(2);
      expect(schema.safeParse({
        publicRoomSlug: "shade-of-love",
        checkin: "2026-08-07",
        checkout: "2026-08-09",
        guests: 2,
        [field]: 1,
      }).success).toBe(false);
    },
  );
});
