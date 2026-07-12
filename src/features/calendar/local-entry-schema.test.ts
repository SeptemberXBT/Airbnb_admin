import { describe, expect, it } from "vitest";
import { localEntrySchema } from "./local-entry-schema";

describe("local calendar entry validation", () => {
  it("accepts a direct reservation with private operational fields", () => {
    const result = localEntrySchema.safeParse({
      propertyId: "00000000-0000-4000-8000-000000000001",
      listingId: null,
      entryType: "direct_reservation",
      startDate: "2026-07-12",
      endDate: "2026-07-14",
      privateBookingName: "Synthetic Guest",
      paymentAmount: 12_500.50,
      privateContact: "0000000000",
      privateNote: "Synthetic fixture only",
      bookingSource: "direct",
      syncToAirbnb: true,
      expectedCheckinTime: "13:00",
      expectedCheckoutTime: "11:00",
      cleaningDurationMinutes: 20,
      allowOverlap: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a blank payment and rejects payments outside the database range", () => {
    const base = {
      propertyId: "00000000-0000-4000-8000-000000000001",
      listingId: null,
      entryType: "blocked",
      startDate: "2026-07-12",
      endDate: "2026-07-13",
      syncToAirbnb: false,
      allowOverlap: false,
    };
    expect(localEntrySchema.safeParse({ ...base, paymentAmount: null }).success).toBe(true);
    expect(localEntrySchema.safeParse({ ...base, paymentAmount: -1 }).success).toBe(false);
    expect(localEntrySchema.safeParse({ ...base, paymentAmount: 10_000_000_000 }).success).toBe(false);
  });

  it("rejects reversed dates and malformed overrides", () => {
    const result = localEntrySchema.safeParse({
      propertyId: "bad",
      listingId: null,
      entryType: "blocked",
      startDate: "2026-07-15",
      endDate: "2026-07-14",
      syncToAirbnb: false,
      expectedCheckinTime: "99:00",
      cleaningDurationMinutes: 2,
      allowOverlap: false,
    });
    expect(result.success).toBe(false);
  });
});
