import assert from "node:assert/strict";
import test from "node:test";
import { buildConsolidationPlan, normalizeIdentity } from "./planner.mjs";

function fixture() {
  return {
    source: {
      users: [{ id: "old-user", email: "owner@example.test" }],
      properties: [{ id: "old-property", name: "  EMERAUDE   603 ", active: true, archived_at: null }],
      property_members: [{ property_id: "old-property", user_id: "old-user", role: "owner" }],
      listings: [{
        id: "old-listing",
        property_id: "old-property",
        display_name: "Emerald Airbnb",
        inbound_ical_url_plaintext: "https://calendar.example/emerald.ics",
        inbound_ical_url_encrypted: "new-ciphertext",
        active: true,
        archived_at: null,
      }],
      external_calendar_events: [],
      local_calendar_entries: [],
      operation_overrides: [],
      cleaning_tasks: [],
      sync_runs: [],
      audit_log: [],
    },
    destination: {
      users: [{ id: "new-user", email: "OWNER@example.test" }],
      properties: [
        { id: "new-property", name: "Emeraude 603", active: true, archived_at: null },
        { id: "history-property", name: "Only booking history", active: true, archived_at: null },
      ],
      property_members: [],
      listings: [{
        id: "new-listing",
        property_id: "new-property",
        display_name: "Emerald Airbnb",
        inbound_ical_url_plaintext: "https://calendar.example/emerald.ics",
        inbound_ical_url_encrypted: "old-new-ciphertext",
      }],
      bookings: [
        { id: "booking-1", property_id: "new-property", checkin: "2026-08-10", checkout: "2026-08-12", status: "confirmed", archived_at: null },
        { id: "booking-2", property_id: "history-property", checkin: "2026-09-01", checkout: "2026-09-02", status: "cancelled", archived_at: null },
      ],
      property_rates: [{ property_id: "new-property", public_room_slug: "emerald-suite", booking_enabled: true }],
      property_rate_overrides: [{ id: "rate-1", property_id: "new-property", stay_date: "2026-08-10", price_paise: 10000 }],
      local_calendar_entries: [{ id: "booking-entry", property_id: "new-property", listing_id: "new-listing", booking_id: "booking-1", active: true }],
      inventory_nights: [],
    },
    fallbackActorId: "new-user",
  };
}

test("normalizes Unicode form, case, and repeated whitespace deterministically", () => {
  assert.equal(normalizeIdentity("  EMERAUDE\u00a0 603 "), "emeraude 603");
  assert.equal(normalizeIdentity("Cafe\u0301"), normalizeIdentity("Café"));
});

test("maps matching property/listing identities and preserves pricing and booking history", () => {
  const plan = buildConsolidationPlan(fixture());
  assert.deepEqual(plan.propertyMap, { "old-property": "new-property" });
  assert.deepEqual(plan.listingMap, { "old-listing": "new-listing" });
  assert.equal(plan.properties.filter((property) => property.id === "new-property").length, 1);
  assert.equal(plan.listings.filter((listing) => listing.id === "new-listing").length, 1);
  assert.equal(plan.propertyRates[0].property_id, "new-property");
  assert.equal(plan.bookingLocalEntries[0].listing_id, "new-listing");
  const fallback = plan.properties.find((property) => property.id === "history-property");
  assert.equal(fallback.active, false);
  assert.equal(fallback.archived_at, "__MIGRATION_TIMESTAMP__");
  assert.equal(plan.actorMap["old-user"], "new-user");
});

test("accepts PostgreSQL date values returned as JavaScript Date objects", () => {
  const input = fixture();
  input.destination.bookings[0].checkin = new Date("2026-08-10T00:00:00.000Z");
  input.destination.bookings[0].checkout = new Date("2026-08-12T00:00:00.000Z");

  const plan = buildConsolidationPlan(input);

  assert.deepEqual(
    plan.inventoryNights
      .filter((night) => night.booking_id === "booking-1")
      .map((night) => night.stay_date),
    ["2026-08-10", "2026-08-11"],
  );
});

test("manual iCal mode preserves calendar history but clears every inbound secret and sync state", () => {
  const input = fixture();
  input.source.external_calendar_events.push({
    id: "historical-event",
    listing_id: "old-listing",
    event_type: "reservation",
    start_date: "2026-01-10",
    end_date: "2026-01-12",
    active: false,
    historical: true,
    archived_at: "2026-01-12T00:00:00.000Z",
  });
  input.source.listings[0].inbound_ical_url_encrypted = "source-secret";
  input.source.listings[0].last_sync_at = "2026-07-01T00:00:00.000Z";
  input.source.listings[0].last_sync_status = "success";

  const plan = buildConsolidationPlan({ ...input, manualIcalReattach: true });

  assert.equal(plan.listings[0].inbound_ical_url_encrypted, null);
  assert.equal(plan.listings[0].last_sync_at, null);
  assert.equal(plan.listings[0].last_sync_status, null);
  assert.equal(plan.externalCalendarEvents[0].id, "historical-event");
  assert.equal(plan.externalCalendarEvents[0].historical, true);
  assert.equal(plan.counts.disconnectedListings, 1);
  assert.doesNotMatch(JSON.stringify(plan), /source-secret/);
});

test("manual iCal mode matches listings by normalized name without plaintext feed comparison", () => {
  const input = fixture();
  input.source.listings[0].inbound_ical_url_plaintext = "https://old.example/source.ics";
  input.destination.listings[0].inbound_ical_url_plaintext = "https://new.example/destination.ics";
  assert.throws(() => buildConsolidationPlan(input), /LISTING_IDENTITY_CONFLICT/);
  assert.doesNotThrow(() => buildConsolidationPlan({ ...input, manualIcalReattach: true }));
});

test("refuses duplicate source property identities", () => {
  const input = fixture();
  input.source.properties.push({ id: "duplicate", name: "Emeraude 603", active: true, archived_at: null });
  assert.throws(() => buildConsolidationPlan(input), /DUPLICATE_SOURCE_PROPERTY_IDENTITY/);
});

test("stops when rebuilt inventory has two owners for one property-night", () => {
  const input = fixture();
  input.destination.bookings = [];
  input.source.external_calendar_events.push({
    id: "event-1",
    listing_id: "old-listing",
    event_type: "reservation",
    start_date: "2026-08-10",
    end_date: "2026-08-12",
    active: true,
    archived_at: null,
  });
  input.source.local_calendar_entries.push({
    id: "manual-1",
    property_id: "old-property",
    listing_id: "old-listing",
    start_date: "2026-08-11",
    end_date: "2026-08-12",
    active: true,
    archived_at: null,
    booking_id: null,
    created_by: "old-user",
  });
  assert.throws(() => buildConsolidationPlan(input), /INVENTORY_OVERLAP/);
});
