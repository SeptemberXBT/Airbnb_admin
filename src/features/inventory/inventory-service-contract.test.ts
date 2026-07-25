import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("inventory reconciliation performance contract", () => {
  it("reconciles a date range with set-based SQL instead of per-night queries", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/features/inventory/inventory-service.ts"),
      "utf8",
    );

    expect(source).toMatch(/generate_series\(/);
    expect(source).toMatch(/insert into public\.inventory_nights[\s\S]*select[\s\S]*from winners/i);
    expect(source).not.toMatch(/for \(const stayDate of dates\)/);
  });
});
