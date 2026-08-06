import { beforeEach, describe, expect, it } from "vitest";

import { resetDb, testSql } from "@/test/db-test-client";
import { createEntryService } from "./entry-service";
import { createOutboundService } from "./outbound-service";
import { hashToken } from "@/lib/security/secrets";
import {
  createEarlyCheckoutService,
  EarlyCheckoutError,
} from "./early-checkout-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-15T08:30:00.000Z");

let propertyId: string;
let listingId: string;

async function insertLocalEntry(overrides: {
  entryType?: "direct_reservation" | "blocked";
  startDate?: string;
  endDate?: string;
  active?: boolean;
  archived?: boolean;
  bookingId?: string | null;
} = {}) {
  const values = {
    propertyId,
    listingId,
    entryType: overrides.entryType ?? "direct_reservation",
    startDate: overrides.startDate ?? "2026-08-14",
    endDate: overrides.endDate ?? "2026-08-18",
    active: overrides.active ?? true,
    archivedAt: overrides.archived ? NOW : null,
    bookingId: overrides.bookingId ?? null,
  };
  const undefinedValue = Object.entries(values).find(([, value]) => value === undefined);
  if (undefinedValue) throw new Error(`Undefined local entry fixture: ${undefinedValue[0]}`);
  const [entry] = await testSql<{ id: string }[]>`
    insert into public.local_calendar_entries (
      property_id, listing_id, entry_type, start_date, end_date,
      private_booking_name, private_contact, private_note, payment_amount,
      booking_source, sync_to_airbnb, active, created_by, archived_at, booking_id
    ) values (
      ${values.propertyId}, ${values.listingId}, ${values.entryType},
      ${values.startDate}, ${values.endDate},
      'Original Guest', '+919999999999', 'Keep this note', 2500.00,
      'direct', true, ${values.active}, ${USER_ID},
      ${values.archivedAt}, ${values.bookingId}
    ) returning id
  `;
  return entry.id;
}

async function activeInventory(entryId: string) {
  return testSql<{ stay_date: string }[]>`
    select stay_date::text
    from public.inventory_nights
    where source_kind = 'manual_local' and source_id = ${entryId} and status = 'active'
    order by stay_date
  `;
}

describe("one-click early checkout", () => {
  beforeEach(async () => {
    await resetDb();
    await testSql`
      insert into auth.users (id, email) values
        (${USER_ID}, 'owner@example.test'),
        (${OTHER_USER_ID}, 'other@example.test')
    `;
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values ('Early Checkout Suite') returning id
    `;
    propertyId = property.id;
    const [listing] = await testSql<{ id: string }[]>`
      insert into public.listings (
        property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash
      ) values (${propertyId}, 'Early Checkout Listing', 'encrypted', ${`hash-${propertyId}`})
      returning id
    `;
    listingId = listing.id;
    await testSql`
      delete from public.property_members
      where property_id = ${propertyId} and user_id = ${OTHER_USER_ID}
    `;
  });

  it("preserves the reservation while releasing inventory and recording the actor", async () => {
    const entries = createEntryService(testSql, "enforced");
    const created = await entries.createLocalEntry({
      propertyId,
      listingId,
      entryType: "direct_reservation",
      startDate: "2026-08-14",
      endDate: "2026-08-18",
      privateBookingName: "Original Guest",
      paymentAmount: 2500,
      privateContact: "+919999999999",
      privateNote: "Keep this note",
      bookingSource: "direct",
      syncToAirbnb: true,
      expectedCheckinTime: null,
      expectedCheckoutTime: null,
      cleaningDurationMinutes: null,
      allowOverlap: false,
    }, USER_ID);
    expect((await activeInventory(created.id)).map((row) => row.stay_date)).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
    ]);
    const outboundToken = "b".repeat(48);
    await testSql`
      update public.listings set outbound_token_hash = ${hashToken(outboundToken)}
      where id = ${listingId}
    `;
    expect(await createOutboundService(testSql).getOutboundCalendar(outboundToken)).toContain("BEGIN:VEVENT");

    const service = createEarlyCheckoutService(testSql, { now: () => NOW });
    const result = await service.completeEarly(created.id, USER_ID);

    expect(result).toMatchObject({
      entryId: created.id,
      earlyCheckoutEffectiveDate: "2026-08-15",
      idempotent: false,
    });
    const [entry] = await testSql<{
      active: boolean;
      archived_at: string | null;
      completed_early_by: string;
      early_checkout_effective_date: string;
      start_date: string;
      end_date: string;
      private_booking_name: string;
      private_contact: string;
      private_note: string;
      payment_amount: string;
    }[]>`
      select active, archived_at::text, completed_early_by,
        early_checkout_effective_date::text, start_date::text, end_date::text,
        private_booking_name, private_contact, private_note, payment_amount::text
      from public.local_calendar_entries where id = ${created.id}
    `;
    expect(entry).toMatchObject({
      active: false,
      archived_at: null,
      completed_early_by: USER_ID,
      early_checkout_effective_date: "2026-08-15",
      start_date: "2026-08-14",
      end_date: "2026-08-18",
      private_booking_name: "Original Guest",
      private_contact: "+919999999999",
      private_note: "Keep this note",
      payment_amount: "2500.00",
    });
    expect(await activeInventory(created.id)).toEqual([]);
    expect(await createOutboundService(testSql).getOutboundCalendar(outboundToken)).not.toContain("BEGIN:VEVENT");
    const [audit] = await testSql<{ action: string; changes: Record<string, unknown> }[]>`
      select action, changes from public.audit_log
      where entity_id = ${created.id} and action = 'completed_early'
    `;
    expect(audit.action).toBe("completed_early");
    expect(audit.changes).toMatchObject({
      originalStartDate: "2026-08-14",
      originalEndDate: "2026-08-18",
      earlyCheckoutEffectiveDate: "2026-08-15",
    });
  });

  it("returns the original completion on retry without another audit record", async () => {
    const entryId = await insertLocalEntry();
    const service = createEarlyCheckoutService(testSql, { now: () => NOW });

    const first = await service.completeEarly(entryId, USER_ID);
    const second = await service.completeEarly(entryId, USER_ID);

    expect(second).toEqual({ ...first, idempotent: true });
    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
      where entity_id = ${entryId} and action = 'completed_early'
    `;
    expect(count).toBe(1);
  });

  it("forbids a user without property membership", async () => {
    const entryId = await insertLocalEntry();
    const service = createEarlyCheckoutService(testSql, { now: () => NOW });

    await expect(service.completeEarly(entryId, OTHER_USER_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    } satisfies Partial<EarlyCheckoutError>);
  });

  it.each([
    ["future direct reservation", { startDate: "2026-08-20", endDate: "2026-08-22" }],
    ["archived direct reservation", { active: false, archived: true }],
    ["blocked calendar entry", { entryType: "blocked" as const }],
  ])("rejects an ineligible %s without mutation", async (_label, overrides) => {
    const entryId = await insertLocalEntry(overrides);
    const service = createEarlyCheckoutService(testSql, { now: () => NOW });

    await expect(service.completeEarly(entryId, USER_ID)).rejects.toMatchObject({
      code: "INELIGIBLE",
      status: 409,
    } satisfies Partial<EarlyCheckoutError>);
    const [entry] = await testSql<{ completed_early_at: string | null }[]>`
      select completed_early_at::text from public.local_calendar_entries where id = ${entryId}
    `;
    expect(entry.completed_early_at).toBeNull();
  });

  it("rejects a website-backed entry", async () => {
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone,
        guest_count, checkin, checkout, amount_paise
      ) values (
        'NH-EARLYWEB1234', ${propertyId}, 'Website Guest', 'website@example.test',
        '+919999999999', 1, '2026-08-14', '2026-08-18', 250000
      ) returning id
    `;
    const entryId = await insertLocalEntry({ bookingId: booking.id });
    const service = createEarlyCheckoutService(testSql, { now: () => NOW });

    await expect(service.completeEarly(entryId, USER_ID)).rejects.toMatchObject({
      code: "INELIGIBLE",
      status: 409,
    } satisfies Partial<EarlyCheckoutError>);
  });

  it("returns not found for a missing or Airbnb-only record", async () => {
    const [external] = await testSql<{ id: string }[]>`
      insert into public.external_calendar_events (
        listing_id, source_uid, event_type, start_date, end_date, source_content_hash
      ) values (
        ${listingId}, 'airbnb-reservation', 'reservation',
        '2026-08-14', '2026-08-18', 'content'
      ) returning id
    `;
    const service = createEarlyCheckoutService(testSql, { now: () => NOW });

    await expect(service.completeEarly(external.id, USER_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    } satisfies Partial<EarlyCheckoutError>);
  });
});
