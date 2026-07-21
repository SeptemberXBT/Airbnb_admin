import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createEntryService } from "./entry-service";
import type { LocalEntryInput } from "./local-entry-schema";

const USER_ID = "10000000-0000-4000-8000-000000000001";
let propertyId: string;
let listingId: string;
let bookingSequence = 0;

function entryInput(overrides: Partial<LocalEntryInput> = {}): LocalEntryInput {
  return {
    propertyId,
    listingId,
    entryType: "blocked",
    startDate: "2026-08-14",
    endDate: "2026-08-16",
    privateBookingName: null,
    paymentAmount: null,
    privateContact: null,
    privateNote: null,
    bookingSource: "admin",
    syncToAirbnb: true,
    expectedCheckinTime: null,
    expectedCheckoutTime: null,
    cleaningDurationMinutes: null,
    allowOverlap: false,
    ...overrides,
  };
}

async function createBooking() {
  bookingSequence += 1;
  const [booking] = await testSql<{ id: string }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, amount_paise
    ) values (
      ${`NH-MANUALBOOK${String(bookingSequence).padStart(4, "0")}`}, ${propertyId},
      'Website Guest', 'website@example.test', '+919999999999', 1,
      '2026-08-14', '2026-08-16', 10000
    ) returning id
  `;
  return booking.id;
}

async function activeInventory() {
  return testSql<{ stay_date: string; source_kind: string; source_id: string }[]>`
    select stay_date::text, source_kind, source_id from public.inventory_nights
    where property_id = ${propertyId} and status = 'active'
    order by stay_date, source_kind, source_id
  `;
}

describe("manual entries through shared inventory", () => {
  beforeEach(async () => {
    await resetDb();
    bookingSequence = 0;
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values ('Manual Entry Suite') returning id
    `;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (
        property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash
      ) values (${propertyId}, 'Manual Entry Listing', 'encrypted', ${`hash-${propertyId}`}) returning id
    `;
    listingId = listing.id;
  });

  it("creates the raw entry, operation override, nightly claims, and audit together", async () => {
    const entries = createEntryService(testSql, "enforced");
    const created = await entries.createLocalEntry(entryInput({
      entryType: "direct_reservation",
      privateBookingName: "Direct Guest",
      paymentAmount: 12500.50,
      expectedCheckinTime: "14:00",
      expectedCheckoutTime: "10:00",
      cleaningDurationMinutes: 25,
    }), USER_ID);

    expect(await activeInventory()).toEqual([
      { stay_date: "2026-08-14", source_kind: "manual_local", source_id: created.id },
      { stay_date: "2026-08-15", source_kind: "manual_local", source_id: created.id },
    ]);
    const [override] = await testSql<{ expected_checkin_time: string; cleaning_duration_minutes: number }[]>`
      select expected_checkin_time::text, cleaning_duration_minutes
      from public.operation_overrides where local_entry_id = ${created.id}
    `;
    expect(override).toMatchObject({ expected_checkin_time: "14:00:00", cleaning_duration_minutes: 25 });
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
      where entity_id = ${created.id} and action = 'created'
    `;
    expect(count).toBe(1);
  });

  it("atomically releases old dates and claims the edited range", async () => {
    const entries = createEntryService(testSql, "enforced");
    const created = await entries.createLocalEntry(entryInput(), USER_ID);
    await entries.updateLocalEntry(created.id, entryInput({ startDate: "2026-08-16", endDate: "2026-08-18" }), USER_ID);

    expect(await activeInventory()).toEqual([
      { stay_date: "2026-08-16", source_kind: "manual_local", source_id: created.id },
      { stay_date: "2026-08-17", source_kind: "manual_local", source_id: created.id },
    ]);
    const released = await testSql<{ stay_date: string }[]>`
      select stay_date::text from public.inventory_nights
      where source_id = ${created.id} and status = 'released' order by stay_date
    `;
    expect(released.map((row) => row.stay_date)).toEqual(["2026-08-14", "2026-08-15"]);
  });

  it("keeps allowOverlap behavior and promotes the remaining raw source after archive", async () => {
    const [external] = await testSql<{ id: string }[]>`
      insert into public.external_calendar_events (
        listing_id, source_uid, event_type, start_date, end_date, source_content_hash
      ) values (${listingId}, 'airbnb-unavailable', 'unavailable', '2026-08-14', '2026-08-16', 'content')
      returning id
    `;
    const entries = createEntryService(testSql, "enforced");
    await expect(entries.createLocalEntry(entryInput(), USER_ID)).rejects.toThrow("OVERLAP");
    const created = await entries.createLocalEntry(entryInput({ allowOverlap: true }), USER_ID);
    expect((await activeInventory()).every((night) => night.source_id === created.id)).toBe(true);

    await entries.archiveLocalEntry(created.id, USER_ID);
    expect(await activeInventory()).toEqual([
      { stay_date: "2026-08-14", source_kind: "airbnb_unavailable", source_id: external.id },
      { stay_date: "2026-08-15", source_kind: "airbnb_unavailable", source_id: external.id },
    ]);
  });

  it("permits a confirmed manual overlap without creating two active ledger owners", async () => {
    const entries = createEntryService(testSql, "enforced");
    const first = await entries.createLocalEntry(entryInput(), USER_ID);
    await expect(entries.createLocalEntry(entryInput(), USER_ID)).rejects.toThrow("OVERLAP");
    const second = await entries.createLocalEntry(entryInput({ allowOverlap: true, privateNote: "Owner-confirmed overlap" }), USER_ID);

    expect((await activeInventory()).every((night) => night.source_id === first.id)).toBe(true);
    expect(await activeInventory()).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
  });

  it("serializes a manual entry against a website hold", async () => {
    const entries = createEntryService(testSql, "enforced");
    const inventory = createInventoryService(testSql);
    const bookingId = await createBooking();
    const hold = inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: "website_hold",
      sourceId: bookingId,
      expiresAt: new Date("2099-08-14T10:00:00.000Z"),
    }));
    const manual = entries.createLocalEntry(entryInput(), USER_ID);

    const results = await Promise.allSettled([hold, manual]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await activeInventory()).toHaveLength(2);
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.local_calendar_entries where property_id = ${propertyId}
    `;
    expect(count).toBe(results[1].status === "fulfilled" ? 1 : 0);
  });

  it("logs a shadow mismatch instead of changing existing manual behavior", async () => {
    const inventory = createInventoryService(testSql);
    const bookingId = await createBooking();
    await inventory.withPropertyInventory(propertyId, (tx) => claimStayNights(tx, {
      propertyId,
      stayDates: ["2026-08-14", "2026-08-15"],
      sourceKind: "website_hold",
      sourceId: bookingId,
      expiresAt: new Date("2099-08-14T10:00:00.000Z"),
    }));
    const entries = createEntryService(testSql, "shadow");
    const created = await entries.createLocalEntry(entryInput(), USER_ID);

    expect(created.id).toBeDefined();
    expect((await activeInventory()).every((night) => night.source_id === bookingId)).toBe(true);
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
      where property_id = ${propertyId} and action = 'inventory_shadow_mismatch'
    `;
    expect(count).toBe(1);
  });

  it("preserves operation override writes and property authorization", async () => {
    const entries = createEntryService(testSql, "enforced");
    const created = await entries.createLocalEntry(entryInput(), USER_ID);
    await entries.saveOperationOverride({
      targetType: "local",
      targetId: created.id,
      propertyId,
      expectedCheckinTime: "15:00",
      expectedCheckoutTime: "09:00",
      cleaningDurationMinutes: 30,
      operationalNote: "Late arrival",
    }, USER_ID);
    const [override] = await testSql<{ operational_note: string }[]>`
      select operational_note from public.operation_overrides where local_entry_id = ${created.id}
    `;
    expect(override.operational_note).toBe("Late arrival");

    await testSql`delete from public.property_members where property_id = ${propertyId} and user_id = ${USER_ID}`;
    await expect(entries.createLocalEntry(entryInput({ startDate: "2026-08-20", endDate: "2026-08-21" }), USER_ID)).rejects.toThrow("FORBIDDEN");
  });
});
