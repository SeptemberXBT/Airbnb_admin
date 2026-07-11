import "server-only";
import { getDb } from "@/lib/db/client";
import { demoCalendar } from "./demo-calendar";
import type { CalendarEntry, CalendarProperty } from "./calendar-types";

export async function getCalendarData(userId: string, startDate: string, days: number): Promise<CalendarProperty[]> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return demoCalendar(startDate);
  const sql = getDb();
  const properties = await sql<{
    id: string; name: string; default_checkin_time: string; default_checkout_time: string;
    default_cleaning_minutes: number; last_sync_at: string | null; last_sync_status: string | null;
  }[]>`
    select p.id, p.name, p.default_checkin_time::text, p.default_checkout_time::text,
      p.default_cleaning_minutes, max(l.last_sync_at)::text as last_sync_at,
      case when bool_or(l.last_sync_status = 'failure') then 'failure' else max(l.last_sync_status::text) end as last_sync_status
    from public.properties p
    join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    left join public.listings l on l.property_id = p.id and l.active and l.archived_at is null
    where p.active and p.archived_at is null
    group by p.id order by p.name
  `;
  const propertyIds = properties.map((property) => property.id);
  if (!propertyIds.length) return [];
  const endDate = new Date(`${startDate}T12:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + days);
  const viewEnd = endDate.toISOString().slice(0, 10);

  const external = await sql<{
    id: string; property_id: string; listing_id: string; event_type: CalendarEntry["kind"];
    start_date: string; end_date: string; sanitized_reservation_url: string | null;
    expected_checkin_time: string | null; expected_checkout_time: string | null;
    cleaning_duration_minutes: number | null; operational_note: string | null;
  }[]>`
    select e.id, l.property_id, e.listing_id, e.event_type, e.start_date::text, e.end_date::text,
      e.sanitized_reservation_url, o.expected_checkin_time::text, o.expected_checkout_time::text,
      o.cleaning_duration_minutes, o.operational_note
    from public.external_calendar_events e join public.listings l on l.id = e.listing_id
    left join public.operation_overrides o on o.external_event_id = e.id
    where l.property_id in ${sql(propertyIds)} and e.active and e.start_date < ${viewEnd} and e.end_date > ${startDate}
  `;
  const local = await sql<{
    id: string; property_id: string; listing_id: string | null; entry_type: CalendarEntry["kind"];
    start_date: string; end_date: string; private_booking_name: string | null; private_contact: string | null;
    private_note: string | null; sync_to_airbnb: boolean; expected_checkin_time: string | null;
    expected_checkout_time: string | null; cleaning_duration_minutes: number | null;
  }[]>`
    select e.id, e.property_id, e.listing_id, e.entry_type, e.start_date::text, e.end_date::text,
      e.private_booking_name, e.private_contact, e.private_note, e.sync_to_airbnb,
      o.expected_checkin_time::text, o.expected_checkout_time::text, o.cleaning_duration_minutes
    from public.local_calendar_entries e left join public.operation_overrides o on o.local_entry_id = e.id
    where e.property_id in ${sql(propertyIds)} and e.active and e.start_date < ${viewEnd} and e.end_date > ${startDate}
  `;
  const entriesByProperty = new Map<string, CalendarEntry[]>();
  const add = (propertyId: string, entry: CalendarEntry) => entriesByProperty.set(propertyId, [...(entriesByProperty.get(propertyId) ?? []), entry]);
  const observedBusyDates = new Set(external
    .filter((row) => row.event_type === "unavailable")
    .map((row) => `${row.property_id}:${row.start_date}:${row.end_date}`));
  for (const row of external) add(row.property_id, {
    id: row.id, propertyId: row.property_id, listingId: row.listing_id, source: "airbnb", kind: row.event_type,
    label: row.event_type === "reservation" ? "Airbnb reservation" : row.event_type === "unavailable" ? "Airbnb unavailable" : "Airbnb event",
    startDate: row.start_date, endDate: row.end_date, privateBookingName: null, privateContact: null,
    privateNote: row.operational_note, expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null,
    expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
    cleaningDurationMinutes: row.cleaning_duration_minutes, reservationUrl: row.sanitized_reservation_url,
    syncToAirbnb: false, airbnbObserved: false,
  });
  for (const row of local) add(row.property_id, {
    id: row.id, propertyId: row.property_id, listingId: row.listing_id, source: "local", kind: row.entry_type,
    label: row.entry_type === "direct_reservation" ? "Direct reservation" : "Blocked",
    startDate: row.start_date, endDate: row.end_date, privateBookingName: row.private_booking_name,
    privateContact: row.private_contact, privateNote: row.private_note,
    expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null,
    expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
    cleaningDurationMinutes: row.cleaning_duration_minutes, reservationUrl: null, syncToAirbnb: row.sync_to_airbnb,
    airbnbObserved: row.sync_to_airbnb && observedBusyDates.has(`${row.property_id}:${row.start_date}:${row.end_date}`),
  });
  return properties.map((property) => ({
    id: property.id, name: property.name, defaultCheckinTime: property.default_checkin_time.slice(0, 5),
    defaultCheckoutTime: property.default_checkout_time.slice(0, 5), defaultCleaningMinutes: property.default_cleaning_minutes,
    lastSyncAt: property.last_sync_at, lastSyncStatus: property.last_sync_status,
    isStale: !property.last_sync_at || Date.now() - new Date(property.last_sync_at).getTime() > 30 * 60 * 1000,
    entries: entriesByProperty.get(property.id) ?? [],
  }));
}
