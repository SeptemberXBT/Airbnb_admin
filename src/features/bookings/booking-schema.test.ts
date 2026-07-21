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
});
