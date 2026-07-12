import { describe, expect, it } from "vitest";
import { buildManualBookingsCsv, splitPaymentAcrossNights } from "./manual-booking-export";

describe("manual booking CSV", () => {
  it("splits total payment exactly across checkout-exclusive nights", () => {
    expect(splitPaymentAcrossNights("1000.00", "2026-07-13", "2026-07-16")).toEqual([
      ["2026-07-13", 33_334],
      ["2026-07-14", 33_333],
      ["2026-07-15", 33_333],
    ]);
  });

  it("exports every requested date and preserves full-stay allocation in a partial range", () => {
    const csv = buildManualBookingsCsv(
      [{ id: "p1", name: "Alpha, Suite" }, { id: "p2", name: "Beta Suite" }],
      [{ propertyId: "p1", startDate: "2026-07-13", endDate: "2026-07-16", guestName: "Riya", paymentAmount: "1000.00" }],
      "2026-07-14",
      "2026-07-15",
    );
    expect(csv).toContain('Date,"Alpha, Suite",Beta Suite');
    expect(csv).toContain("2026-07-14,Riya - INR 333.33,");
    expect(csv).toContain("2026-07-15,Riya - INR 333.33,");
    expect(csv).not.toContain("2026-07-16");
  });

  it("combines overlaps and protects spreadsheet formulas and quotes", () => {
    const csv = buildManualBookingsCsv(
      [{ id: "p1", name: "Suite" }],
      [
        { propertyId: "p1", startDate: "2026-07-13", endDate: "2026-07-14", guestName: "=IMPORT()", paymentAmount: null },
        { propertyId: "p1", startDate: "2026-07-13", endDate: "2026-07-14", guestName: 'A "Guest"', paymentAmount: "50.00" },
      ],
      "2026-07-13",
      "2026-07-13",
    );
    expect(csv).toContain('"\'=IMPORT() | A ""Guest"" - INR 50.00"');
  });
});
