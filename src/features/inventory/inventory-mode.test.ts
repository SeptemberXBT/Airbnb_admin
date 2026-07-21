import { describe, expect, it } from "vitest";
import { parseInventoryLedgerMode } from "./inventory-mode";

describe("inventory ledger mode", () => {
  it("defaults to shadow mode when absent", () => {
    expect(parseInventoryLedgerMode(undefined)).toBe("shadow");
  });

  it.each(["shadow", "enforced"] as const)("accepts explicit %s mode", (mode) => {
    expect(parseInventoryLedgerMode(mode)).toBe(mode);
  });

  it.each(["", "true", "enforce", "disabled"])("fails closed on invalid mode %j", (mode) => {
    expect(() => parseInventoryLedgerMode(mode)).toThrow("INVALID_INVENTORY_LEDGER_MODE");
  });
});
