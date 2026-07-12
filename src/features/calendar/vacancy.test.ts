import { describe, expect, it } from "vitest";
import { calculateVacancy } from "./vacancy";

describe("vacancy calculation", () => {
  it("counts checkout nights as vacant and treats every busy entry kind as occupied", () => {
    const summary = calculateVacancy([
      { id: "a", name: "Suite A", isStale: false, entries: [
        { id: "a1", kind: "reservation", startDate: "2026-07-10", endDate: "2026-07-12" },
      ] },
      { id: "b", name: "Suite B", isStale: false, entries: [
        { id: "b1", kind: "blocked", startDate: "2026-07-12", endDate: "2026-07-13" },
      ] },
      { id: "c", name: "Suite C", isStale: true, entries: [] },
    ], "2026-07-11", "2026-07-13");

    expect(summary.byDate.map(({ date, vacantPropertyIds }) => ({ date, vacantPropertyIds }))).toEqual([
      { date: "2026-07-11", vacantPropertyIds: ["b", "c"] },
      { date: "2026-07-12", vacantPropertyIds: ["a", "c"] },
      { date: "2026-07-13", vacantPropertyIds: ["a", "b", "c"] },
    ]);
    expect(summary.totalVacantRoomNights).toBe(7);
    expect(summary.byProperty).toEqual([
      { propertyId: "a", propertyName: "Suite A", vacantNights: 2, isStale: false },
      { propertyId: "b", propertyName: "Suite B", vacantNights: 2, isStale: false },
      { propertyId: "c", propertyName: "Suite C", vacantNights: 3, isStale: true },
    ]);
    expect(summary.hasStaleData).toBe(true);
  });

  it("rejects reversed and oversized inclusive ranges", () => {
    expect(() => calculateVacancy([], "2026-07-12", "2026-07-11")).toThrow("INVALID_RANGE");
    expect(() => calculateVacancy([], "2025-01-01", "2026-01-02")).toThrow("RANGE_TOO_LARGE");
  });
});
