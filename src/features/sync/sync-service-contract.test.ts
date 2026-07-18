import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("calendar sync history persistence", () => {
  it("loads and persists every reconciliation history state", async () => {
    const source = await readFile(path.join(process.cwd(), "src/features/sync/sync-service.ts"), "utf8");

    expect(source).toMatch(/select id, source_uid, source_content_hash, start_date::text, end_date::text, active, historical/i);
    expect(source).toMatch(/formatInTimeZone\(new Date\(\), "Asia\/Kolkata", "yyyy-MM-dd"\)/);
    expect(source).toMatch(/active = true, historical = false, archived_at = null/i);
    expect(source).toMatch(/active = false, historical = false, archived_at = coalesce\(archived_at, now\(\)\)/i);
    expect(source).toMatch(/active = false, historical = true, archived_at = coalesce\(archived_at, now\(\)\)/i);
  });
});
