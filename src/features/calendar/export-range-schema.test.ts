import { describe, expect, it } from "vitest";
import { exportRangeSchema } from "./export-range-schema";

describe("manual booking export range", () => {
  it("accepts inclusive ranges up to 366 dates", () => {
    expect(exportRangeSchema.safeParse({ start: "2026-07-13", end: "2026-07-13" }).success).toBe(true);
    expect(exportRangeSchema.safeParse({ start: "2026-01-01", end: "2027-01-01" }).success).toBe(true);
  });

  it("rejects reversed, oversized, and malformed ranges", () => {
    expect(exportRangeSchema.safeParse({ start: "2026-07-14", end: "2026-07-13" }).success).toBe(false);
    expect(exportRangeSchema.safeParse({ start: "2026-01-01", end: "2027-01-02" }).success).toBe(false);
    expect(exportRangeSchema.safeParse({ start: "bad", end: "2026-07-13" }).success).toBe(false);
  });
});
