import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { getDb } from "@/lib/db/client";
import { parseAirbnbCalendar, type NormalizedCalendarEvent } from "@/lib/ical/parser";
import { openSecret } from "@/lib/security/secrets";
import type postgres from "postgres";
import { createInventoryService, reconcilePropertyNights } from "@/features/inventory/inventory-service";
import { getInventoryLedgerMode, type InventoryLedgerMode } from "@/features/inventory/inventory-mode";
import { recordPropertyShadowMismatches } from "@/features/inventory/shadow-service";
import { cancelWebsiteBookingForAirbnbCollision } from "@/features/bookings/cancellation-service";
import { fetchCalendar } from "./fetch-calendar";
import { affectedReconciliationBounds, planReconciliation } from "./reconcile";
import { mapWithConcurrency, sanitizeSyncError } from "./sync-security";

type SyncListing = { id: string; encrypted_url: string };
type SyncSource = "scheduled" | "manual";

type SyncSql = postgres.Sql;

export function createSyncReconciliationService(sql: SyncSql, inventoryMode: InventoryLedgerMode) {
  const inventory = createInventoryService(sql);
  return {
    async applyReconciliation(listingId: string, incoming: NormalizedCalendarEvent[], todayDate: string) {
      const [listing] = await sql<{ property_id: string }[]>`
        select property_id from public.listings where id = ${listingId} and archived_at is null
      `;
      if (!listing) throw new Error("LISTING_NOT_FOUND");
      const propertyId = listing.property_id;
      return inventory.withPropertyInventory(propertyId, async (tx) => {
        const rows = await tx<{
          id: string; source_uid: string; source_content_hash: string; start_date: string;
          end_date: string; active: boolean; historical: boolean;
        }[]>`
          select id, source_uid, source_content_hash, start_date::text, end_date::text, active, historical
          from public.external_calendar_events where listing_id = ${listingId}
        `;
        const existing = rows.map((row) => ({
          id: row.id, sourceUid: row.source_uid, contentHash: row.source_content_hash,
          startDate: row.start_date, endDate: row.end_date, active: row.active, historical: row.historical,
        }));
        const plan = planReconciliation(existing, incoming, todayDate);
        const changedExistingIds = new Set([
          ...plan.update.map(({ existingId }) => existingId),
          ...plan.archive,
          ...plan.retainHistory,
        ]);
        const bounds = affectedReconciliationBounds(
          existing.filter((event) => changedExistingIds.has(event.id)),
          incoming,
        );

        for (const event of plan.create) {
          await tx`
            insert into public.external_calendar_events (
              listing_id, source_uid, event_type, start_date, end_date,
              sanitized_reservation_url, source_content_hash, active, historical, archived_at
            ) values (
              ${listingId}, ${event.sourceUid}, ${event.eventType}, ${event.startDate}, ${event.endDate},
              ${event.sanitizedReservationUrl}, ${event.contentHash}, true, false, null
            )
            on conflict (listing_id, source_uid) do update set
              event_type = excluded.event_type, start_date = excluded.start_date,
              end_date = excluded.end_date, sanitized_reservation_url = excluded.sanitized_reservation_url,
              source_content_hash = excluded.source_content_hash, last_seen_at = now(),
              active = true, historical = false, archived_at = null
          `;
        }
        for (const { existingId, event } of plan.update) {
          await tx`
            update public.external_calendar_events set event_type = ${event.eventType},
              start_date = ${event.startDate}, end_date = ${event.endDate},
              sanitized_reservation_url = ${event.sanitizedReservationUrl},
              source_content_hash = ${event.contentHash}, last_seen_at = now(),
              active = true, historical = false, archived_at = null where id = ${existingId}
          `;
        }
        if (plan.archive.length) {
          await tx`
            update public.external_calendar_events set active = false, historical = false, archived_at = coalesce(archived_at, now())
            where id in ${tx(plan.archive)}
          `;
        }
        if (plan.retainHistory.length) {
          await tx`
            update public.external_calendar_events set active = false, historical = true, archived_at = coalesce(archived_at, now())
            where id in ${tx(plan.retainHistory)}
          `;
        }
        if (incoming.length) {
          await tx`
            update public.external_calendar_events set last_seen_at = now()
            where listing_id = ${listingId} and source_uid in ${tx(incoming.map((event) => event.sourceUid))}
          `;
        }

        const collisionRows = bounds ? await tx<{ booking_id: string; stay_dates: string[] }[]>`
          select i.booking_id, array_agg(distinct i.stay_date::text order by i.stay_date::text) as stay_dates
          from public.inventory_nights i
          where i.property_id = ${propertyId} and i.status = 'active'
            and i.source_kind in ('website_hold', 'website_booking')
            and exists (
              select 1 from public.external_calendar_events e
              join public.listings l on l.id = e.listing_id
              where l.property_id = ${propertyId} and e.active = true and e.archived_at is null
                and e.event_type = 'reservation'
                and e.start_date <= i.stay_date and e.end_date > i.stay_date
            )
          group by i.booking_id
          order by i.booking_id
        ` : [];

        if (inventoryMode === "enforced") {
          for (const collision of collisionRows) {
            const [reservation] = await tx<{ id: string }[]>`
              select e.id from public.external_calendar_events e
              join public.listings l on l.id = e.listing_id
              where l.property_id = ${propertyId} and e.event_type = 'reservation'
                and e.active = true and e.archived_at is null
                and exists (
                  select 1 from public.inventory_nights i
                  where i.booking_id = ${collision.booking_id} and i.status = 'active'
                    and i.stay_date >= e.start_date and i.stay_date < e.end_date
                )
              order by e.first_seen_at, e.id
              limit 1
            `;
            if (reservation) {
              await cancelWebsiteBookingForAirbnbCollision(tx, collision.booking_id, reservation.id);
            }
          }
        }

        const confirmedBlockAlerts = bounds ? await tx<{ booking_id: string; external_event_id: string }[]>`
          select distinct i.booking_id, e.id as external_event_id
          from public.inventory_nights i
          join public.bookings b on b.id = i.booking_id and b.status = 'confirmed'
          join public.external_calendar_events e on e.event_type in ('unavailable', 'unknown')
            and e.active = true and e.archived_at is null
            and e.start_date <= i.stay_date and e.end_date > i.stay_date
          join public.listings l on l.id = e.listing_id and l.property_id = i.property_id
          where i.property_id = ${propertyId} and i.source_kind = 'website_booking' and i.status = 'active'
          order by i.booking_id, e.id
        ` : [];
        for (const alert of confirmedBlockAlerts) {
          const [existingAlert] = await tx`
            select 1 from public.audit_log
            where property_id = ${propertyId}
              and action = 'airbnb_calendar_block_overlaps_confirmed_booking'
              and entity_id = ${alert.booking_id}
              and changes->>'externalEventId' = ${alert.external_event_id}
            limit 1
          `;
          if (!existingAlert) await tx`
            insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
            values (
              ${propertyId}, 'airbnb_calendar_block_overlaps_confirmed_booking',
              'website_booking', ${alert.booking_id}, ${tx.json({ externalEventId: alert.external_event_id })}
            )
          `;
        }

        const displacedRows = bounds && inventoryMode === "enforced"
          ? await tx<{ booking_id: string; stay_dates: string[] }[]>`
              select i.booking_id, array_agg(distinct i.stay_date::text order by i.stay_date::text) as stay_dates
              from public.inventory_nights i
              join public.bookings b on b.id = i.booking_id
              where i.property_id = ${propertyId}
                and i.source_kind = 'website_hold' and i.status = 'active'
                and b.razorpay_payment_id is null
                and b.status in ('processing', 'held')
                and exists (
                  select 1 from public.external_calendar_events e
                  join public.listings l on l.id = e.listing_id
                  where l.property_id = ${propertyId} and e.active = true and e.archived_at is null
                    and e.event_type in ('unavailable', 'unknown')
                    and e.start_date <= i.stay_date and e.end_date > i.stay_date
                )
              group by i.booking_id
              order by i.booking_id
            `
          : [];

        const collisionBookingIds = new Set(collisionRows.map((collision) => collision.booking_id));
        for (const displaced of displacedRows) {
          if (collisionBookingIds.has(displaced.booking_id)) continue;
          const [expired] = await tx<{ id: string }[]>`
            update public.bookings
            set status = 'expired', updated_at = now()
            where id = ${displaced.booking_id}
              and razorpay_payment_id is null
              and status in ('processing', 'held')
            returning id
          `;
          if (!expired) continue;
          await tx`
            update public.inventory_nights
            set status = 'released', release_reason = 'airbnb_calendar_block', released_at = now(), updated_at = now()
            where property_id = ${propertyId} and booking_id = ${displaced.booking_id}
              and source_kind = 'website_hold' and status = 'active'
          `;
          const metadata = tx.json({ stayDates: displaced.stay_dates, reason: "airbnb_calendar_block" });
          await tx`
            insert into public.booking_events (property_id, booking_id, event_type, metadata)
            values (${propertyId}, ${displaced.booking_id}, 'airbnb_calendar_block_displaced_hold', ${metadata})
          `;
          await tx`
            insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
            values (
              ${propertyId}, 'airbnb_calendar_block_displaced_hold', 'website_booking',
              ${displaced.booking_id}, ${metadata}
            )
          `;
        }

        if (bounds) {
          await reconcilePropertyNights(tx, propertyId, bounds.startDate, bounds.endDate);
          if (inventoryMode === "shadow") {
            await recordPropertyShadowMismatches(tx, propertyId, bounds.startDate, bounds.endDate);
          }
        }
        return {
          created: plan.create.length,
          updated: plan.update.length,
          archived: plan.archive.length,
          collisions: collisionRows.map((row) => ({ bookingId: row.booking_id, stayDates: row.stay_dates })),
        };
      });
    },
  };
}

async function syncListing(listing: SyncListing, source: SyncSource) {
  const sql = getDb();
  const [run] = await sql<{ id: string }[]>`
    insert into public.sync_runs (listing_id, trigger_source) values (${listing.id}, ${source}) returning id
  `;
  try {
    const key = process.env.ICAL_ENCRYPTION_KEY;
    if (!key) throw new Error("sync_configuration_error");
    const feedText = await fetchCalendar(openSecret(listing.encrypted_url, key));
    const incoming = parseAirbnbCalendar(feedText);
    const counts = await createSyncReconciliationService(sql, getInventoryLedgerMode()).applyReconciliation(
      listing.id,
      incoming,
      formatInTimeZone(new Date(), "Asia/Kolkata", "yyyy-MM-dd"),
    );
    await sql.begin(async (tx) => {
      await tx`
        update public.sync_runs set completed_at = now(), status = 'success', fetched_event_count = ${incoming.length},
          created_count = ${counts.created}, updated_count = ${counts.updated}, archived_count = ${counts.archived}
        where id = ${run.id}
      `;
      await tx`
        update public.listings set last_sync_at = now(), last_sync_status = 'success',
          last_sync_error_code = null, updated_at = now() where id = ${listing.id}
      `;
    });
    return { listingId: listing.id, status: "success" as const, fetched: incoming.length, ...counts };
  } catch (error) {
    const safe = sanitizeSyncError(error);
    await sql.begin(async (tx) => {
      await tx`
        update public.sync_runs set completed_at = now(), status = 'failure', error_code = ${safe.code},
          sanitized_error_message = ${safe.message} where id = ${run.id}
      `;
      await tx`
        update public.listings set last_sync_status = 'failure', last_sync_error_code = ${safe.code}, updated_at = now()
        where id = ${listing.id}
      `;
    });
    return { listingId: listing.id, status: "failure" as const, errorCode: safe.code };
  }
}

async function getListings(source: SyncSource, userId?: string) {
  const sql = getDb();
  if (source === "manual") {
    return sql<SyncListing[]>`
      select l.id, l.inbound_ical_url_encrypted as encrypted_url from public.listings l
      where l.active and l.archived_at is null
        and l.inbound_ical_url_encrypted is not null and exists (
        select 1 from public.property_members pm where pm.property_id = l.property_id and pm.user_id = ${userId ?? ""}
      ) order by l.id
    `;
  }
  return sql<SyncListing[]>`
    select id, inbound_ical_url_encrypted as encrypted_url from public.listings
    where active and archived_at is null
      and inbound_ical_url_encrypted is not null order by id
  `;
}

export async function runCalendarSync(source: SyncSource, userId?: string) {
  const sql = getDb();
  if (source === "manual") {
    const [recent] = await sql`
      select 1 from public.sync_runs sr join public.listings l on l.id = sr.listing_id
      where sr.trigger_source = 'manual' and sr.started_at > now() - interval '60 seconds'
        and exists (select 1 from public.property_members pm where pm.property_id = l.property_id and pm.user_id = ${userId ?? ""})
      limit 1
    `;
    if (recent) return { status: "cooldown" as const, results: [] };
  }

  return sql.begin(async (lockTx) => {
    const [lock] = await lockTx<{ acquired: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext('airbnb_operations_calendar_sync')) as acquired
    `;
    if (!lock.acquired) return { status: "locked" as const, results: [] };
    const listings = await getListings(source, userId);
    const settled = await mapWithConcurrency(listings, 4, (listing) => syncListing(listing, source));
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { listingId: listings[index].id, status: "failure" as const, errorCode: "sync_failed" });
    return { status: "completed" as const, results };
  });
}
