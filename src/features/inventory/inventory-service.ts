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
    update public.inventory_nights i
    set status = 'released', release_reason = 'hold_expired', released_at = ${now}, updated_at = ${now}
    from public.bookings b
    where i.property_id = ${propertyId}
      and i.booking_id = b.id
      and i.source_kind = 'website_hold'
      and i.status = 'active'
      and i.expires_at <= ${now}
      and b.status = 'expired'
    returning i.id
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
  const replaced = await tx<{ id: string }[]>`
    with stay_dates as (
      select generate_series(
        ${startDate}::date,
        ${endDate}::date - 1,
        interval '1 day'
      )::date as stay_date
    ),
    winners as (
      select dates.stay_date, winner.source_kind, winner.source_id
      from stay_dates dates
      cross join lateral (
        select candidates.source_kind, candidates.source_id
        from (
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
            and e.start_date <= dates.stay_date and e.end_date > dates.stay_date
          union all
          select 'manual_local' as source_kind, m.id as source_id, 2 as priority, m.created_at
          from public.local_calendar_entries m
          where m.property_id = ${propertyId} and m.active = true and m.archived_at is null
            and m.start_date <= dates.stay_date and m.end_date > dates.stay_date
        ) candidates
        order by candidates.priority, candidates.created_at, candidates.source_id
        limit 1
      ) winner
    )
    update public.inventory_nights i
    set status = 'released', release_reason = 'reconciled_replaced',
      released_at = now(), updated_at = now()
    from winners
    where i.property_id = ${propertyId}
      and i.stay_date = winners.stay_date
      and i.status = 'active'
      and i.source_kind not in ('website_hold', 'website_booking')
      and row(i.source_kind, i.source_id) is distinct from row(winners.source_kind, winners.source_id)
    returning i.id
  `;

  await tx`
    with stay_dates as (
      select generate_series(
        ${startDate}::date,
        ${endDate}::date - 1,
        interval '1 day'
      )::date as stay_date
    ),
    winners as (
      select dates.stay_date, winner.source_kind, winner.source_id
      from stay_dates dates
      cross join lateral (
        select candidates.source_kind, candidates.source_id
        from (
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
            and e.start_date <= dates.stay_date and e.end_date > dates.stay_date
          union all
          select 'manual_local' as source_kind, m.id as source_id, 2 as priority, m.created_at
          from public.local_calendar_entries m
          where m.property_id = ${propertyId} and m.active = true and m.archived_at is null
            and m.start_date <= dates.stay_date and m.end_date > dates.stay_date
        ) candidates
        order by candidates.priority, candidates.created_at, candidates.source_id
        limit 1
      ) winner
    )
    insert into public.inventory_nights (
      property_id, stay_date, source_kind, source_id,
      booking_id, local_entry_id, external_event_id
    )
    select
      ${propertyId}, winners.stay_date, winners.source_kind, winners.source_id,
      null,
      case when winners.source_kind = 'manual_local' then winners.source_id else null end,
      case when winners.source_kind <> 'manual_local' then winners.source_id else null end
    from winners
    where not exists (
      select 1 from public.inventory_nights current
      where current.property_id = ${propertyId}
        and current.stay_date = winners.stay_date
        and current.status = 'active'
    )
    on conflict (property_id, stay_date) where status = 'active' do nothing
  `;
  return released.length + replaced.length;
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
