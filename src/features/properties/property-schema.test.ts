import { describe, expect, it } from "vitest";

async function loadSubject() {
  try {
    return await import("./property-schema");
  } catch {
    return undefined;
  }
}

describe("property and listing validation", () => {
  it("accepts universal operating defaults without property-level arrival times", async () => {
    const subject = await loadSubject();
    const result = subject?.propertyListingSchema.safeParse({
      name: "Garden Suite",
      displayName: "Garden Suite on Airbnb",
      timezone: "Asia/Kolkata",
      defaultCleaningMinutes: 15,
      checkoutBufferMinutes: 5,
      checkinBufferMinutes: 5,
      inboundIcalUrl: "https://www.airbnb.co.in/calendar/ical/123.ics?s=secret",
    });

    expect(result?.success).toBe(true);
    expect(result?.data).not.toHaveProperty("defaultCheckinTime");
    expect(result?.data).not.toHaveProperty("defaultCheckoutTime");
  });

  it("requires a stable request ID for property creation", async () => {
    const subject = await loadSubject();
    const base = {
      name: "Garden Suite", displayName: "Garden Suite on Airbnb", timezone: "Asia/Kolkata",
      defaultCleaningMinutes: 15, checkoutBufferMinutes: 5, checkinBufferMinutes: 5,
      inboundIcalUrl: "https://www.airbnb.co.in/calendar/ical/123.ics?s=secret",
    };
    expect(subject?.createPropertyListingSchema.safeParse(base).success).toBe(false);
    expect(subject?.createPropertyListingSchema.safeParse({ ...base, creationRequestId: "10000000-0000-4000-8000-000000000001" }).success).toBe(true);
  });

  it("rejects invalid duration, timezone, buffers, and non-HTTPS feed values", async () => {
    const subject = await loadSubject();
    const result = subject?.propertyListingSchema.safeParse({
      name: "Room",
      displayName: "Room",
      timezone: "UTC",
      defaultCleaningMinutes: 0,
      checkoutBufferMinutes: -1,
      checkinBufferMinutes: 999,
      inboundIcalUrl: "http://example.com/private.ics",
    });

    expect(result?.success).toBe(false);
  });

  it("rejects HTTPS feeds outside Airbnb calendar exports", async () => {
    const subject = await loadSubject();
    const result = subject?.propertyListingSchema.safeParse({
      name: "Garden Suite", displayName: "Garden Suite", timezone: "Asia/Kolkata",
      defaultCleaningMinutes: 15,
      checkoutBufferMinutes: 5, checkinBufferMinutes: 5,
      inboundIcalUrl: "https://example.com/calendar/private.ics",
    });
    expect(result?.success).toBe(false);
  });

  it("never returns inbound secrets in a client listing projection", async () => {
    const subject = await loadSubject();
    const projected = subject?.toListingClient({
      id: "listing-1",
      property_id: "property-1",
      display_name: "Garden Suite",
      platform: "airbnb",
      inbound_ical_url_encrypted: "ciphertext",
      outbound_token_hash: "hash",
      outbound_enabled: true,
      active: true,
      last_sync_at: null,
      last_sync_status: null,
    });

    expect(projected).toEqual({
      id: "listing-1",
      propertyId: "property-1",
      displayName: "Garden Suite",
      platform: "airbnb",
      outboundEnabled: true,
      active: true,
      lastSyncAt: null,
      lastSyncStatus: null,
    });
    expect(JSON.stringify(projected)).not.toContain("ciphertext");
    expect(JSON.stringify(projected)).not.toContain("hash");
  });
});
