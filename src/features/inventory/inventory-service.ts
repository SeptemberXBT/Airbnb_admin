import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { expandStayDates, parseStayDate } from "./date-range";
import {
  INVENTORY_SOURCE_KINDS,
  type InventoryClaim,
  type InventorySourceKind,
  type InventoryTransaction,
} from "./inventory-types";

type InventorySql = postgres.Sql;
const LOCKED_PROPERTY_SETTING = "noirhaus.inventory_property_id";

function assertSourceKind(value: string): asserts value is InventorySourceKind {
  if (!(INVENTORY_SOURCE_KINDS as readonly string[]).includes(value)) throw new Error("INVALID_INVENTORY_SOURCE");
}

function normalizeStayDates(stayDates: string[]) {
  if (stayDates.length === 0) throw new Error("INVALID_STAY_RANGE");
  const unique = [...new Set(stayDates)];
  if (unique.length !== stayDates.length) throw new Error("DUPLICATE_STAY_DATE");
  unique.forEach(parseStayDate);
  return unique.sort();
}

function sourceTargets(sourceKind: InventorySourceKind, sourceId: string) {
  if (sourceKind === "website_hold" || sourceKind === "website_booking") {
    return { bookingId: sourceId, localEntryId: null, externalEventId: null };
  }
  if (sourceKind === "manual_local") {
    return { bookingId: null, localEntryId: sourceId, externalEventId: null };
  }
  return { bookingId: null, localEntryId: null, externalEventId: sourceId };
}

function isInventoryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; constraint_name?: string; constraint?: string };
  return value.code === "23505"
    && (value.constraint_name === "inventory_nights_one_active_owner"
      || value.constraint === "inventory_nights_one_active_owner");
}

async function lockedPropertyId(tx: InventoryTransaction) {
  const [row] = await tx<{ property_id: string | null }[]>`
    select nullif(current_setting(${LOCKED_PROPERTY_SETTING}, true), '') as property_id
  `;
  if (!row?.property_id) throw new Error("INVENTORY_LOCK_REQUIRED");
  return row.property_id;
}

async function requirePropertyLock(tx: InventoryTransaction, propertyId: string) {
  if (await lockedPropertyId(tx) !== propertyId) throw new Error("INVENTORY_LOCK_MISMATCH");
}

export async function claimStayNights(tx: InventoryTransaction, claim: InventoryClaim) {
  assertSourceKind(claim.sourceKind);
  await requirePropertyLock(tx, claim.propertyId);
  const stayDates = normalizeStayDates(claim.stayDates);
  if (claim.sourceKind === "website_hold" && (!(claim.expiresAt instanceof Date) || Number.isNaN(claim.expiresAt.getTime()))) {
    throw new Error("INVALID_HOLD_EXPIRY");
  }

  const existing = await tx<{ stay_date: string }[]>`
    select stay_date::text from public.inventory_nights
    where property_id = ${claim.propertyId}
      and stay_date in ${tx(stayDates)}
      and status = 'active'
    limit 1
  `;
  if (existing.length > 0) throw new Error("INVENTORY_UNAVAILABLE");

  const targets = sourceTargets(claim.sourceKind, claim.sourceId);
  try {
    for (const stayDate of stayDates) {
      await tx`
        insert into public.inventory_nights (
          property_id, stay_date, source_kind, source_id,
          booking_id, local_entry_id, external_event_id, expires_at
        ) values (
          ${claim.propertyId}, ${stayDate}, ${claim.sourceKind}, ${claim.sourceId},
          ${targets.bookingId}, ${targets.localEntryId}, ${targets.externalEventId},
          ${claim.sourceKind === "website_hold" ? claim.expiresAt : null}
        )
      `;
    }
  } catch (error) {
    if (isInventoryConflict(error)) throw new Error("INVENTORY_UNAVAILABLE");
    throw error;
  }
  return stayDates.length;
}

export async function releaseSourceNights(
  tx: InventoryTransaction,
  sourceKind: InventorySourceKind,
  sourceId: string,
  reason: string,
) {
  assertSourceKind(sourceKind);
  const propertyId = await lockedPropertyId(tx);
  const released = await tx<{ id: string }[]>`
    update public.inventory_nights
    set status = 'released', release_reason = ${reason}, released_at = now(), updated_at = now()
    where property_id = ${propertyId} and source_kind = ${sourceKind}
      and source_id = ${sourceId} and status = 'active'
    returning id
  `;
  return released.length;
}

export async function releaseExpiredHolds(
  tx: InventoryTransaction,
  propertyId: string,
  now: Date,
) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("INVALID_NOW");
  await requirePropertyLock(tx, propertyId);
  const released = await tx<{ id: string }[]>`
    update public.inventory_nights
    set status = 'released', release_reason = 'hold_expired', released_at = ${now}, updated_at = ${now}
    where property_id = ${propertyId}
      and source_kind = 'website_hold'
      and status = 'active'
      and expires_at <= ${now}
    returning id
  `;
  return released.length;
}

export async function reconcilePropertyNights(
  tx: InventoryTransaction,
  propertyId: string,
  startDate: string,
  endDate: string,
) {
  await requirePropertyLock(tx, propertyId);
  const dates = expandStayDates(startDate, endDate);
  const released = await tx<{ id: string }[]>`
    update public.inventory_nights i
    set status = 'released', release_reason = 'source_inactive', released_at = now(), updated_at = now()
    where i.property_id = ${propertyId}
      and i.stay_date in ${tx(dates)}
      and i.status = 'active'
      and (
        (i.source_kind in ('website_hold', 'website_booking') and not exists (
          select 1 from public.bookings b
          where b.id = i.booking_id and b.status not in ('payment_failed', 'expired', 'cancelled')
        ))
        or (i.source_kind = 'manual_local' and not exists (
          select 1 from public.local_calendar_entries l
          where l.id = i.local_entry_id and l.active = true and l.archived_at is null
            and l.start_date <= i.stay_date and l.end_date > i.stay_date
        ))
        or (i.source_kind in ('airbnb_reservation', 'airbnb_unavailable', 'airbnb_unknown') and not exists (
          select 1 from public.external_calendar_events e
          where e.id = i.external_event_id and e.active = true and e.archived_at is null
            and e.start_date <= i.stay_date and e.end_date > i.stay_date
        ))
      )
    returning i.id
  `;
  let replaced = 0;
  for (const stayDate of dates) {
    const [current] = await tx<{ id: string; source_kind: InventorySourceKind; source_id: string }[]>`
      select id, source_kind, source_id from public.inventory_nights
      where property_id = ${propertyId} and stay_date = ${stayDate} and status = 'active'
    `;
    if (current && (current.source_kind === "website_hold" || current.source_kind === "website_booking")) continue;

    const [winner] = await tx<{ source_kind: InventorySourceKind; source_id: string }[]>`
      select source_kind, source_id from (
        select
          case e.event_type
            when 'reservation' then 'airbnb_reservation'
            when 'unavailable' then 'airbnb_unavailable'
            else 'airbnb_unknown'
          end as source_kind,
          e.id as source_id,
          case when e.event_type = 'reservation' then 1 else 3 end as priority,
          e.first_seen_at as created_at
        from public.external_calendar_events e
        join public.listings l on l.id = e.listing_id
        where l.property_id = ${propertyId} and e.active = true and e.archived_at is null
          and e.start_date <= ${stayDate} and e.end_date > ${stayDate}
        union all
        select 'manual_local' as source_kind, m.id as source_id, 2 as priority, m.created_at
        from public.local_calendar_entries m
        where m.property_id = ${propertyId} and m.active = true and m.archived_at is null
          and m.start_date <= ${stayDate} and m.end_date > ${stayDate}
      ) candidates
      order by priority, created_at, source_id
      limit 1
    `;

    if (!winner || (current?.source_kind === winner.source_kind && current.source_id === winner.source_id)) continue;
    if (current) {
      await tx`
        update public.inventory_nights
        set status = 'released', release_reason = 'reconciled_replaced', released_at = now(), updated_at = now()
        where id = ${current.id}
      `;
      replaced += 1;
    }
    if (winner.source_kind === "website_hold") throw new Error("INVALID_INVENTORY_SOURCE");
    await claimStayNights(tx, {
      propertyId,
      stayDates: [stayDate],
      sourceKind: winner.source_kind,
      sourceId: winner.source_id,
    });
  }
  return released.length + replaced;
}

export function createInventoryService(sql: InventorySql) {
  return {
    async withPropertyInventory<T>(
      propertyId: string,
      callback: (tx: InventoryTransaction) => Promise<T>,
    ) {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${propertyId}, 0))`;
        await tx`select set_config(${LOCKED_PROPERTY_SETTING}, ${propertyId}, true)`;
        await releaseExpiredHolds(tx, propertyId, new Date());
        return callback(tx);
      });
    },
  };
}

export function withPropertyInventory<T>(
  propertyId: string,
  callback: (tx: InventoryTransaction) => Promise<T>,
) {
  return createInventoryService(getDb()).withPropertyInventory(propertyId, callback);
}
