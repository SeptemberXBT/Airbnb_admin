import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import {
  createInventoryService,
  reconcilePropertyNights,
  releaseSourceNights,
} from "@/features/inventory/inventory-service";
import { expandStayDates } from "@/features/inventory/date-range";
import { getInventoryLedgerMode, type InventoryLedgerMode } from "@/features/inventory/inventory-mode";
import type { InventoryTransaction } from "@/features/inventory/inventory-types";
import type { LocalEntryInput } from "./local-entry-schema";

type EntrySql = postgres.Sql;

async function assertPropertyAccess(tx: InventoryTransaction, propertyId: string, userId: string) {
  const [allowed] = await tx`
    select 1 from public.property_members where property_id = ${propertyId} and user_id = ${userId}
  `;
  if (!allowed) throw new Error("FORBIDDEN");
}

async function assertListingTarget(tx: InventoryTransaction, propertyId: string, listingId: string | null | undefined) {
  if (!listingId) return;
  const [listing] = await tx`
    select 1 from public.listings
    where id = ${listingId} and property_id = ${propertyId} and archived_at is null
  `;
  if (!listing) throw new Error("FORBIDDEN");
}

async function hasRawOverlap(tx: InventoryTransaction, input: LocalEntryInput, excludeId?: string) {
  const [overlap] = await tx`
    select 1 from (
      select e.id from public.local_calendar_entries e
      where e.property_id = ${input.propertyId} and e.active
        and (${excludeId ?? null}::uuid is null or e.id <> ${excludeId ?? null})
        and e.start_date < ${input.endDate} and e.end_date > ${input.startDate}
      union all
      select e.id from public.external_calendar_events e
      join public.listings l on l.id = e.listing_id
      where l.property_id = ${input.propertyId} and (e.active or e.historical)
        and e.start_date < ${input.endDate} and e.end_date > ${input.startDate}
    ) conflicts limit 1
  `;
  return Boolean(overlap);
}

async function websiteInventoryOverlap(tx: InventoryTransaction, propertyId: string, startDate: string, endDate: string) {
  const dates = expandStayDates(startDate, endDate);
  const [overlap] = await tx`
    select 1 from public.inventory_nights
    where property_id = ${propertyId} and stay_date in ${tx(dates)} and status = 'active'
      and source_kind in ('website_hold', 'website_booking')
    limit 1
  `;
  return Boolean(overlap);
}

function hasOverride(input: LocalEntryInput) {
  return Boolean(input.expectedCheckinTime || input.expectedCheckoutTime || input.cleaningDurationMinutes);
}

async function recordShadowMismatch(
  tx: InventoryTransaction,
  propertyId: string,
  userId: string,
  entryId: string,
  startDate: string,
  endDate: string,
) {
  await tx`
    insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
    values (
      ${propertyId}, ${userId}, 'inventory_shadow_mismatch', 'local_calendar_entry', ${entryId},
      ${tx.json({ startDate, endDate, reason: "website_inventory_overlap" })}
    )
  `;
}

function translateInventoryError(error: unknown): never {
  if (error instanceof Error && error.message === "INVENTORY_UNAVAILABLE") throw new Error("OVERLAP");
  throw error;
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

export function createEntryService(sql: EntrySql, inventoryMode: InventoryLedgerMode) {
  const inventory = createInventoryService(sql);
  return {
    async createLocalEntry(input: LocalEntryInput, userId: string) {
      try {
        return await inventory.withPropertyInventory(input.propertyId, async (tx) => {
          await assertPropertyAccess(tx, input.propertyId, userId);
          await assertListingTarget(tx, input.propertyId, input.listingId);
          if (!input.allowOverlap && await hasRawOverlap(tx, input)) throw new Error("OVERLAP");
          const websiteConflict = await websiteInventoryOverlap(tx, input.propertyId, input.startDate, input.endDate);
          if (websiteConflict && inventoryMode === "enforced") throw new Error("OVERLAP");

          const [entry] = await tx<{ id: string }[]>`
            insert into public.local_calendar_entries (
              property_id, listing_id, entry_type, start_date, end_date, private_booking_name,
              payment_amount, private_contact, private_note, booking_source, sync_to_airbnb, created_by
            ) values (
              ${input.propertyId}, ${input.listingId ?? null}, ${input.entryType}, ${input.startDate}, ${input.endDate},
              ${input.privateBookingName ?? null}, ${input.paymentAmount ?? null}, ${input.privateContact ?? null},
              ${input.privateNote ?? null}, ${input.bookingSource ?? null}, ${input.syncToAirbnb}, ${userId}
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
          if (websiteConflict) await recordShadowMismatch(tx, input.propertyId, userId, entry.id, input.startDate, input.endDate);
          await reconcilePropertyNights(tx, input.propertyId, input.startDate, input.endDate);
          await tx`
            insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
            values (${input.propertyId}, ${userId}, 'created', 'local_calendar_entry', ${entry.id},
              ${tx.json({ entryType: input.entryType, startDate: input.startDate, endDate: input.endDate, syncToAirbnb: input.syncToAirbnb, paymentRecorded: input.paymentAmount != null })})
          `;
          return entry;
        });
      } catch (error) {
        return translateInventoryError(error);
      }
    },

    async updateLocalEntry(entryId: string, input: LocalEntryInput, userId: string) {
      try {
        await inventory.withPropertyInventory(input.propertyId, async (tx) => {
          await assertPropertyAccess(tx, input.propertyId, userId);
          await assertListingTarget(tx, input.propertyId, input.listingId);
          const [existing] = await tx<{ start_date: string; end_date: string }[]>`
            select start_date::text, end_date::text from public.local_calendar_entries
            where id = ${entryId} and property_id = ${input.propertyId} and active
          `;
          if (!existing) throw new Error("NOT_FOUND");
          if (!input.allowOverlap && await hasRawOverlap(tx, input, entryId)) throw new Error("OVERLAP");
          const websiteConflict = await websiteInventoryOverlap(tx, input.propertyId, input.startDate, input.endDate);
          if (websiteConflict && inventoryMode === "enforced") throw new Error("OVERLAP");

          await tx`
            update public.local_calendar_entries set
              listing_id = ${input.listingId ?? null}, entry_type = ${input.entryType},
              start_date = ${input.startDate}, end_date = ${input.endDate},
              private_booking_name = ${input.privateBookingName ?? null}, payment_amount = ${input.paymentAmount ?? null},
              private_contact = ${input.privateContact ?? null}, private_note = ${input.privateNote ?? null},
              booking_source = ${input.bookingSource ?? null}, sync_to_airbnb = ${input.syncToAirbnb}, updated_at = now()
            where id = ${entryId}
          `;
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
          await releaseSourceNights(tx, "manual_local", entryId, "entry_dates_changed");
          const affectedStart = existing.start_date < input.startDate ? existing.start_date : input.startDate;
          const affectedEnd = existing.end_date > input.endDate ? existing.end_date : input.endDate;
          if (websiteConflict) await recordShadowMismatch(tx, input.propertyId, userId, entryId, input.startDate, input.endDate);
          await reconcilePropertyNights(tx, input.propertyId, affectedStart, affectedEnd);
          await tx`
            insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
            values (${input.propertyId}, ${userId}, 'updated', 'local_calendar_entry', ${entryId},
              ${tx.json({ entryType: input.entryType, startDate: input.startDate, endDate: input.endDate, syncToAirbnb: input.syncToAirbnb, paymentRecorded: input.paymentAmount != null })})
          `;
        });
      } catch (error) {
        return translateInventoryError(error);
      }
    },

    async archiveLocalEntry(entryId: string, userId: string) {
      const [lookup] = await sql<{ property_id: string }[]>`
        select e.property_id from public.local_calendar_entries e
        join public.property_members pm on pm.property_id = e.property_id and pm.user_id = ${userId}
        where e.id = ${entryId} and e.active
      `;
      if (!lookup) throw new Error("NOT_FOUND");
      await inventory.withPropertyInventory(lookup.property_id, async (tx) => {
        await assertPropertyAccess(tx, lookup.property_id, userId);
        const [entry] = await tx<{ start_date: string; end_date: string }[]>`
          update public.local_calendar_entries
          set active = false, archived_at = now(), updated_at = now()
          where id = ${entryId} and property_id = ${lookup.property_id} and active
          returning start_date::text, end_date::text
        `;
        if (!entry) throw new Error("NOT_FOUND");
        await releaseSourceNights(tx, "manual_local", entryId, "entry_archived");
        await reconcilePropertyNights(tx, lookup.property_id, entry.start_date, entry.end_date);
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id)
          values (${lookup.property_id}, ${userId}, 'archived', 'local_calendar_entry', ${entryId})
        `;
      });
    },

    async saveOperationOverride(input: OverrideInput, userId: string) {
      await sql.begin(async (tx) => {
        const [allowed] = await tx`
          select 1 from public.property_members where property_id = ${input.propertyId} and user_id = ${userId}
        `;
        if (!allowed) throw new Error("FORBIDDEN");
        const [target] = input.targetType === "external"
          ? await tx`select 1 from public.external_calendar_events e join public.listings l on l.id = e.listing_id where e.id = ${input.targetId} and l.property_id = ${input.propertyId}`
          : await tx`select 1 from public.local_calendar_entries e where e.id = ${input.targetId} and e.property_id = ${input.propertyId}`;
        if (!target) throw new Error("FORBIDDEN");
        const externalId = input.targetType === "external" ? input.targetId : null;
        const localId = input.targetType === "local" ? input.targetId : null;
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
    },
  };
}

function entryService() {
  return createEntryService(getDb(), getInventoryLedgerMode());
}

export function createLocalEntry(input: LocalEntryInput, userId: string) {
  return entryService().createLocalEntry(input, userId);
}

export function updateLocalEntry(entryId: string, input: LocalEntryInput, userId: string) {
  return entryService().updateLocalEntry(entryId, input, userId);
}

export function archiveLocalEntry(entryId: string, userId: string) {
  return entryService().archiveLocalEntry(entryId, userId);
}

export function saveOperationOverride(input: OverrideInput, userId: string) {
  return entryService().saveOperationOverride(input, userId);
}
