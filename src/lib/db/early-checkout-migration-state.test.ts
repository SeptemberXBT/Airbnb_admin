import { describe, expect, it } from "vitest";

import { decideEarlyCheckoutMigrationAction } from "./early-checkout-migration-state";

describe("decideEarlyCheckoutMigrationAction", () => {
  it("applies migration 0010 only when every marker is absent", () => {
    expect(decideEarlyCheckoutMigrationAction(0)).toBe("apply");
  });

  it("skips migration 0010 only when every marker is present", () => {
    expect(decideEarlyCheckoutMigrationAction(4)).toBe("skip");
  });

  it.each([1, 2, 3])("stops when migration 0010 has %i of 4 markers", (presentMarkers) => {
    expect(() => decideEarlyCheckoutMigrationAction(presentMarkers)).toThrow(
      `Production migration 0010 is partially applied (${presentMarkers}/4 markers present)`,
    );
  });

  it("rejects impossible marker counts", () => {
    expect(() => decideEarlyCheckoutMigrationAction(-1)).toThrow("Invalid migration marker count");
    expect(() => decideEarlyCheckoutMigrationAction(5)).toThrow("Invalid migration marker count");
  });
});
