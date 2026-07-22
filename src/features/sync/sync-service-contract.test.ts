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
    expect(source).toMatch(/select[^;]*property_id[^;]*from public\.listings/is);
    expect(source).toMatch(/withPropertyInventory\(propertyId/i);
    expect(source).toMatch(/reconcilePropertyNights\(/i);
  });

  it("excludes disconnected listings from both manual and scheduled sync", async () => {
    const source = await readFile(path.join(process.cwd(), "src/features/sync/sync-service.ts"), "utf8");
    const connectedFilters = source.match(/inbound_ical_url_encrypted is not null/gi) ?? [];

    expect(connectedFilters).toHaveLength(2);
    expect(source).toMatch(/where l\.active and l\.archived_at is null[\s\S]*l\.inbound_ical_url_encrypted is not null/i);
    expect(source).toMatch(/where active and archived_at is null[\s\S]*inbound_ical_url_encrypted is not null/i);
  });
});
