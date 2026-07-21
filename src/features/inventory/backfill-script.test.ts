import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("booking inventory backfill command", () => {
  it("requires a database URL and an explicit production confirmation", async () => {
    const source = await readFile(path.join(process.cwd(), "scripts/backfill-booking-inventory.mjs"), "utf8");
    expect(source).toMatch(/DATABASE_URL/);
    expect(source).toMatch(/NODE_ENV\s*===\s*["']production["']/);
    expect(source).toMatch(/CONFIRM_BOOKING_BACKFILL\s*!==\s*["']yes["']/);
    expect(source).toMatch(/JSON\.stringify\([^)]*properties[^)]*activeNights/s);
    expect(source).not.toMatch(/guest_(?:name|email|phone)/i);
  });

  it("is exposed as an explicit npm command", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["backfill:inventory"]).toContain("backfill-booking-inventory.mjs");
  });
});
