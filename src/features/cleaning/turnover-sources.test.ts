import { describe, expect, it } from "vitest";
import { externalTurnoverTypes, isExternalTurnoverType } from "./turnover-sources";

describe("external turnover sources", () => {
  it("includes Airbnb reservations and unavailable periods but excludes unknown events", () => {
    expect(externalTurnoverTypes).toEqual(["reservation", "unavailable"]);
    expect(isExternalTurnoverType("reservation")).toBe(true);
    expect(isExternalTurnoverType("unavailable")).toBe(true);
    expect(isExternalTurnoverType("unknown")).toBe(false);
  });
});
