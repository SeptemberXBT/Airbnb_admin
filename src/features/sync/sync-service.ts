import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { getDb } from "@/lib/db/client";
import { parseAirbnbCalendar, type NormalizedCalendarEvent } from "@/lib/ical/parser";
import { openSecret } from "@/lib/security/secrets";
import { fetchCalendar } from "./fetch-calendar";
import { planReconciliation } from "./reconcile";
import { mapWithConcurrency, sanitizeSyncError } from "./sync-security";

type SyncListing = { id: string; encrypted_url: string };
type SyncSource = "scheduled" | "manual";

async function applyReconciliation(listingId: string, incoming: NormalizedCalendarEvent[]) {
  const sql = getDb();
  const rows = await sql<{
    id: string; source_uid: string; source_content_hash: string; start_date: string;
    end_date: string; active: boolean; historical: boolean;
  }[]>`
    select id, source_uid, source_content_hash, start_date::text, end_date::text, active, historical
    from public.external_calendar_events where listing_id = ${listingId}
  `;
  const plan = planReconciliation(
    rows.map((row) => ({
      id: row.id, sourceUid: row.source_uid, contentHash: row.source_content_hash,
      startDate: row.start_date, endDate: row.end_date, active: row.active, historical: row.historical,
    })),
    incoming,
    formatInTimeZone(new Date(), "Asia/Kolkata", "yyyy-MM-dd"),
  );

  await sql.begin(async (tx) => {
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
  });
  return { created: plan.create.length, updated: plan.update.length, archived: plan.archive.length };
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
    const counts = await applyReconciliation(listing.id, incoming);
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
      where l.active and l.archived_at is null and exists (
        select 1 from public.property_members pm where pm.property_id = l.property_id and pm.user_id = ${userId ?? ""}
      ) order by l.id
    `;
  }
  return sql<SyncListing[]>`
    select id, inbound_ical_url_encrypted as encrypted_url from public.listings
    where active and archived_at is null order by id
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

  const lockConnection = await sql.reserve();
  try {
    const [lock] = await lockConnection<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(hashtext('airbnb_operations_calendar_sync')) as acquired
    `;
    if (!lock.acquired) return { status: "locked" as const, results: [] };
    const listings = await getListings(source, userId);
    const settled = await mapWithConcurrency(listings, 4, (listing) => syncListing(listing, source));
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { listingId: listings[index].id, status: "failure" as const, errorCode: "sync_failed" });
    return { status: "completed" as const, results };
  } finally {
    await lockConnection`select pg_advisory_unlock(hashtext('airbnb_operations_calendar_sync'))`;
    lockConnection.release();
  }
}
