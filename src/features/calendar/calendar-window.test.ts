import { describe, expect, it } from "vitest";
import { calendarWindowVersion, mergeCalendarWindows, trimCalendarWindow } from "./calendar-window";
import type { CalendarProperty } from "./calendar-types";

const property = (entries: CalendarProperty["entries"], lastSyncAt = "2026-07-12T08:00:00.000Z"): CalendarProperty => ({
  id: "property-1",
  name: "Suite A",
  defaultCheckinTime: "13:00",
  defaultCheckoutTime: "11:00",
  defaultCleaningMinutes: 30,
  lastSyncAt,
  lastSyncStatus: "success",
  isStale: false,
  entries,
});
const entry = (id: string, startDate: string, endDate: string): CalendarProperty["entries"][number] => ({
  id,
  propertyId: "property-1",
  listingId: "listing-1",
  source: "airbnb",
  kind: "reservation",
  label: "Airbnb reservation",
  startDate,
  endDate,
  privateBookingName: null,
  privateContact: null,
  privateNote: null,
  expectedCheckinTime: null,
  expectedCheckoutTime: null,
  cleaningDurationMinutes: null,
  reservationUrl: null,
  syncToAirbnb: false,
  airbnbObserved: false,
});

describe("calendar window state", () => {
  it("merges property windows without duplicating entries and keeps fresh metadata", () => {
    const merged = mergeCalendarWindows(
      [property([entry("a", "2026-07-10", "2026-07-13")])],
      [property([entry("a", "2026-07-10", "2026-07-13"), entry("b", "2026-07-20", "2026-07-22")], "2026-07-12T09:00:00.000Z")],
    );
    expect(merged[0].entries.map((item) => item.id)).toEqual(["a", "b"]);
    expect(merged[0].lastSyncAt).toBe("2026-07-12T09:00:00.000Z");
  });

  it("trims entries outside the retained rolling window but keeps overlapping stays", () => {
    const trimmed = trimCalendarWindow([property([
      entry("before", "2026-06-01", "2026-06-03"),
      entry("overlap", "2026-06-30", "2026-07-02"),
      entry("inside", "2026-07-10", "2026-07-12"),
      entry("after", "2026-08-01", "2026-08-03"),
    ])], "2026-07-01", "2026-08-01");
    expect(trimmed[0].entries.map((item) => item.id)).toEqual(["overlap", "inside"]);
  });

  it("changes its version when shared calendar data changes", () => {
    const original = property([entry("a", "2026-07-10", "2026-07-13")]);
    const changed = property([{ ...entry("a", "2026-07-10", "2026-07-14"), expectedCheckoutTime: "12:00" }]);

    expect(calendarWindowVersion([changed])).not.toBe(calendarWindowVersion([original]));
  });
});
