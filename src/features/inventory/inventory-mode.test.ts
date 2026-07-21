import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInventoryLedgerMode } from "./inventory-mode";

describe("inventory ledger mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("defaults to shadow mode when absent", () => {
    expect(parseInventoryLedgerMode(undefined)).toBe("shadow");
  });

  it.each(["shadow", "enforced"] as const)("accepts explicit %s mode", (mode) => {
    expect(parseInventoryLedgerMode(mode)).toBe(mode);
  });

  it.each(["", "true", "enforce", "disabled"])("fails closed on invalid mode %j", (mode) => {
    expect(() => parseInventoryLedgerMode(mode)).toThrow("INVALID_INVENTORY_LEDGER_MODE");
  });

  it("rejects an invalid mode while the Next application configuration loads", async () => {
    vi.stubEnv("INVENTORY_LEDGER_MODE", "invalid-at-startup");
    await expect(import("../../../next.config")).rejects.toThrow("INVALID_INVENTORY_LEDGER_MODE");
  });
});
