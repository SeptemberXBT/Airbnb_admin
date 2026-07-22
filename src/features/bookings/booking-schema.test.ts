import { describe, expect, it } from "vitest";
import { createAvailabilityRequestSchema, createBookingRequestSchema } from "./booking-schema";

const today = "2026-07-21";
const stay = {
  publicRoomSlug: "shade-of-love",
  checkin: "2026-08-14",
  checkout: "2026-08-16",
  guests: 2,
};

describe("public booking schemas", () => {
  it("accepts strict availability and guest booking input", () => {
    expect(createAvailabilityRequestSchema(today).parse(stay)).toEqual(stay);
    expect(createBookingRequestSchema(today).parse({
      ...stay,
      guestName: "Noir Guest",
      guestEmail: "guest@example.test",
      guestPhone: "+91 99999 99999",
    })).toMatchObject({ guestName: "Noir Guest" });
  });

  it("accepts the premium checkout fields and defaults the country to India", () => {
    expect(createBookingRequestSchema(today).parse({
      ...stay,
      firstName: "Riya",
      lastName: "Sharma",
      fullGuestName: "Riya Sharma",
      guestEmail: "riya@example.test",
      guestPhone: "+91 99999 99999",
      notes: "Late arrival, if possible.",
    })).toMatchObject({
      firstName: "Riya",
      lastName: "Sharma",
      fullGuestName: "Riya Sharma",
      countryCode: "IN",
      notes: "Late arrival, if possible.",
    });
  });

  it("requires first and last name for the premium checkout but keeps legacy guestName compatible", () => {
    const schema = createBookingRequestSchema(today);
    expect(schema.safeParse({
      ...stay,
      firstName: "Riya",
      guestEmail: "riya@example.test",
      guestPhone: "+919999999999",
    }).success).toBe(false);
    expect(schema.safeParse({
      ...stay,
      guestName: "Legacy Guest",
      guestEmail: "legacy@example.test",
      guestPhone: "+919999999999",
    }).success).toBe(true);
  });

  it.each(["amount", "price", "pricePaise", "currency", "discount", "tax", "fee"])(
    "rejects client-supplied %s",
    (field) => {
      expect(createBookingRequestSchema(today).safeParse({
        ...stay,
        guestName: "Noir Guest",
        guestEmail: "guest@example.test",
        guestPhone: "+919999999999",
        [field]: 1,
      }).success).toBe(false);
    },
  );

  it("rejects past arrivals, non-exclusive ranges, malformed guests, and unknown rooms", () => {
    const schema = createBookingRequestSchema(today);
    expect(schema.safeParse({ ...stay, checkin: "2026-07-20", guestName: "Noir Guest", guestEmail: "guest@example.test", guestPhone: "+919999999999" }).success).toBe(false);
    expect(schema.safeParse({ ...stay, checkout: stay.checkin, guestName: "Noir Guest", guestEmail: "guest@example.test", guestPhone: "+919999999999" }).success).toBe(false);
    expect(schema.safeParse({ ...stay, publicRoomSlug: "made-up-room", guestName: "N", guestEmail: "bad", guestPhone: "1" }).success).toBe(false);
  });

  it("bounds public work to 30 nights and a 365-day booking horizon", () => {
    const schema = createAvailabilityRequestSchema(today);
    expect(schema.safeParse({ ...stay, checkin: "2026-07-21", checkout: "2026-08-20" }).success).toBe(true);
    expect(schema.safeParse({ ...stay, checkin: "2026-07-21", checkout: "2026-08-21" }).success).toBe(false);
    expect(schema.safeParse({ ...stay, checkin: "2027-07-21", checkout: "2027-07-22" }).success).toBe(true);
    expect(schema.safeParse({ ...stay, checkin: "2027-07-22", checkout: "2027-07-23" }).success).toBe(false);
  });
});
