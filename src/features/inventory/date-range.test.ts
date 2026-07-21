import { describe, expect, it } from "vitest";
import { expandStayDates } from "./date-range";

describe("inventory date ranges", () => {
  it("expands stay dates with checkout as the exclusive end", () => {
    expect(expandStayDates("2026-08-14", "2026-08-17")).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it.each([
    ["2026-08-14", "2026-08-14", "INVALID_STAY_RANGE"],
    ["2026-08-15", "2026-08-14", "INVALID_STAY_RANGE"],
    ["2026-02-30", "2026-03-02", "INVALID_STAY_DATE"],
    ["14-08-2026", "2026-08-15", "INVALID_STAY_DATE"],
  ])("rejects invalid range %s to %s", (start, end, error) => {
    expect(() => expandStayDates(start, end)).toThrow(error);
  });
});
