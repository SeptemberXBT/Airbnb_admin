import { describe, expect, it } from "vitest";
import { compareInventoryOccupancy, shadowMismatchAuditPayload } from "./shadow-service";

describe("inventory shadow comparison", () => {
  it("reports only occupancy differences without source or guest data", () => {
    const mismatches = compareInventoryOccupancy(
      ["2026-08-14", "2026-08-15"],
      ["2026-08-15", "2026-08-16"],
    );
    expect(mismatches).toEqual([
      { stayDate: "2026-08-14", rawOccupied: true, ledgerOccupied: false },
      { stayDate: "2026-08-16", rawOccupied: false, ledgerOccupied: true },
    ]);
    expect(shadowMismatchAuditPayload(mismatches)).toEqual({
      mismatchCount: 2,
      dates: ["2026-08-14", "2026-08-16"],
    });
  });

  it("returns no mismatch when both occupancy sets agree", () => {
    expect(compareInventoryOccupancy(["2026-08-14"], ["2026-08-14"])).toEqual([]);
  });
});
