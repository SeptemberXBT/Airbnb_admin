import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("property inbound iCal connection state", () => {
  it("exposes only connection state and resets sync metadata when a replacement URL is saved", async () => {
    const source = await readFile(path.join(process.cwd(), "src/features/properties/property-service.ts"), "utf8");

    expect(source).toMatch(/inbound_ical_url_encrypted is not null as inbound_ical_connected/i);
    expect(source).toMatch(/inboundIcalConnected: row\.inbound_ical_connected/i);
    expect(source).toMatch(/inbound_ical_url_encrypted = \$\{sealSecret\(input\.inboundIcalUrl, encryptionKey\)\}/i);
    expect(source).toMatch(/last_sync_at = null[\s\S]*last_sync_status = null[\s\S]*last_sync_error_code = null/i);
    expect(source).not.toMatch(/inbound_ical_url_encrypted as inboundIcal/i);
  });
});
