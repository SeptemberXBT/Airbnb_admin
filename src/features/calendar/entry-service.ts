import "server-only";
import { getDb } from "@/lib/db/client";
import type { LocalEntryInput } from "./local-entry-schema";

async function assertPropertyAccess(propertyId: string, userId: string) {
  const sql = getDb();
  const [allowed] = await sql`select 1 from public.property_members where property_id = ${propertyId} and user_id = ${userId}`;
  if (!allowed) throw new Error("FORBIDDEN");
}

async function assertOverrideTarget(propertyId: string, targetType: "external" | "local", targetId: string) {
  const sql = getDb();
  const [target] = targetType === "external"
    ? await sql`select 1 from public.external_calendar_events e join public.listings l on l.id = e.listing_id where e.id = ${targetId} and l.property_id = ${propertyId}`
    : await sql`select 1 from public.local_calendar_entries e where e.id = ${targetId} and e.property_id = ${propertyId}`;
  if (!target) throw new Error("FORBIDDEN");
}

async function assertListingTarget(propertyId: string, listingId: string | null | undefined) {
  if (!listingId) return;
  const sql = getDb();
  const [listing] = await sql`select 1 from public.listings where id = ${listingId} and property_id = ${propertyId} and archived_at is null`;
  if (!listing) throw new Error("FORBIDDEN");
}

async function hasOverlap(input: LocalEntryInput, excludeId?: string) {
  const sql = getDb();
  const [overlap] = await sql`
    select 1 from (
      select e.id from public.local_calendar_entries e
      where e.property_id = ${input.propertyId} and e.active
        and (${excludeId ?? null}::uuid is null or e.id <> ${excludeId ?? null})
        and e.start_date < ${input.endDate} and e.end_date > ${input.startDate}
      union all
      select e.id from public.external_calendar_events e join public.listings l on l.id = e.listing_id
      where l.property_id = ${input.propertyId} and e.active
        and e.start_date < ${input.endDate} and e.end_date > ${input.startDate}
    ) conflicts limit 1
  `;
  return Boolean(overlap);
}

function hasOverride(input: LocalEntryInput) {
  return Boolean(input.expectedCheckinTime || input.expectedCheckoutTime || input.cleaningDurationMinutes);
}

export async function createLocalEntry(input: LocalEntryInput, userId: string) {
  await assertPropertyAccess(input.propertyId, userId);
  await assertListingTarget(input.propertyId, input.listingId);
  if (!input.allowOverlap && await hasOverlap(input)) throw new Error("OVERLAP");
  const sql = getDb();
  return sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into public.local_calendar_entries (
        property_id, listing_id, entry_type, start_date, end_date, private_booking_name,
        private_contact, private_note, booking_source, sync_to_airbnb, created_by
      ) values (
        ${input.propertyId}, ${input.listingId ?? null}, ${input.entryType}, ${input.startDate}, ${input.endDate},
        ${input.privateBookingName ?? null}, ${input.privateContact ?? null}, ${input.privateNote ?? null},
        ${input.bookingSource ?? null}, ${input.syncToAirbnb}, ${userId}
      ) returning id
    `;
    if (hasOverride(input)) await tx`
      insert into public.operation_overrides (
        local_entry_id, expected_checkin_time, expected_checkout_time, cleaning_duration_minutes, updated_by
      ) values (
        ${entry.id}, ${input.expectedCheckinTime ?? null}, ${input.expectedCheckoutTime ?? null},
        ${input.cleaningDurationMinutes ?? null}, ${userId}
      )
    `;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${input.propertyId}, ${userId}, 'created', 'local_calendar_entry', ${entry.id},
        ${tx.json({ entryType: input.entryType, startDate: input.startDate, endDate: input.endDate, syncToAirbnb: input.syncToAirbnb })})
    `;
    return entry;
  });
}

export async function updateLocalEntry(entryId: string, input: LocalEntryInput, userId: string) {
  await assertPropertyAccess(input.propertyId, userId);
  await assertListingTarget(input.propertyId, input.listingId);
  if (!input.allowOverlap && await hasOverlap(input, entryId)) throw new Error("OVERLAP");
  const sql = getDb();
  await sql.begin(async (tx) => {
    const [entry] = await tx`
      update public.local_calendar_entries set entry_type = ${input.entryType}, start_date = ${input.startDate},
        end_date = ${input.endDate}, private_booking_name = ${input.privateBookingName ?? null},
        private_contact = ${input.privateContact ?? null}, private_note = ${input.privateNote ?? null},
        booking_source = ${input.bookingSource ?? null}, sync_to_airbnb = ${input.syncToAirbnb}, updated_at = now()
      where id = ${entryId} and property_id = ${input.propertyId} and active returning id
    `;
    if (!entry) throw new Error("NOT_FOUND");
    await tx`
      insert into public.operation_overrides (
        local_entry_id, expected_checkin_time, expected_checkout_time, cleaning_duration_minutes, updated_by
      ) values (
        ${entryId}, ${input.expectedCheckinTime ?? null}, ${input.expectedCheckoutTime ?? null},
        ${input.cleaningDurationMinutes ?? null}, ${userId}
      ) on conflict (external_event_id, local_entry_id) do update set
        expected_checkin_time = excluded.expected_checkin_time,
        expected_checkout_time = excluded.expected_checkout_time,
        cleaning_duration_minutes = excluded.cleaning_duration_minutes,
        updated_by = excluded.updated_by, updated_at = now()
    `;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${input.propertyId}, ${userId}, 'updated', 'local_calendar_entry', ${entryId},
        ${tx.json({ entryType: input.entryType, startDate: input.startDate, endDate: input.endDate, syncToAirbnb: input.syncToAirbnb })})
    `;
  });
}

export async function archiveLocalEntry(entryId: string, userId: string) {
  const sql = getDb();
  const [entry] = await sql<{ property_id: string }[]>`
    select e.property_id from public.local_calendar_entries e join public.property_members pm
      on pm.property_id = e.property_id and pm.user_id = ${userId}
    where e.id = ${entryId} and e.active
  `;
  if (!entry) throw new Error("NOT_FOUND");
  await sql.begin(async (tx) => {
    await tx`update public.local_calendar_entries set active = false, archived_at = now(), updated_at = now() where id = ${entryId}`;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id)
      values (${entry.property_id}, ${userId}, 'archived', 'local_calendar_entry', ${entryId})
    `;
  });
}

export type OverrideInput = {
  targetType: "external" | "local";
  targetId: string;
  propertyId: string;
  expectedCheckinTime: string | null;
  expectedCheckoutTime: string | null;
  cleaningDurationMinutes: number | null;
  operationalNote: string | null;
};

export async function saveOperationOverride(input: OverrideInput, userId: string) {
  await assertPropertyAccess(input.propertyId, userId);
  await assertOverrideTarget(input.propertyId, input.targetType, input.targetId);
  const sql = getDb();
  const externalId = input.targetType === "external" ? input.targetId : null;
  const localId = input.targetType === "local" ? input.targetId : null;
  await sql.begin(async (tx) => {
    await tx`
      insert into public.operation_overrides (
        external_event_id, local_entry_id, expected_checkin_time, expected_checkout_time,
        cleaning_duration_minutes, operational_note, updated_by
      ) values (
        ${externalId}, ${localId}, ${input.expectedCheckinTime}, ${input.expectedCheckoutTime},
        ${input.cleaningDurationMinutes}, ${input.operationalNote}, ${userId}
      ) on conflict (external_event_id, local_entry_id) do update set
        expected_checkin_time = excluded.expected_checkin_time,
        expected_checkout_time = excluded.expected_checkout_time,
        cleaning_duration_minutes = excluded.cleaning_duration_minutes,
        operational_note = excluded.operational_note, updated_by = excluded.updated_by, updated_at = now()
    `;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${input.propertyId}, ${userId}, 'override_updated', 'calendar_entry', ${input.targetId},
        ${tx.json({ expectedCheckinTime: input.expectedCheckinTime, expectedCheckoutTime: input.expectedCheckoutTime, cleaningDurationMinutes: input.cleaningDurationMinutes })})
    `;
  });
}
