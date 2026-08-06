import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { demoCalendar } from "./demo-calendar";
import type { CalendarAlert, CalendarEntry, CalendarProperty } from "./calendar-types";
import { calculateVacancy } from "./vacancy";

async function getCalendarDataWithSql(sql: postgres.Sql, userId: string, startDate: string, days: number): Promise<CalendarProperty[]> {
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
    where l.property_id in ${sql(propertyIds)} and (e.active or e.historical) and e.start_date < ${viewEnd} and e.end_date > ${startDate}
  `;
  const local = await sql<{
    id: string; property_id: string; listing_id: string | null; entry_type: CalendarEntry["kind"];
    start_date: string; end_date: string; private_booking_name: string | null; private_contact: string | null;
    private_note: string | null; payment_amount: string | null; sync_to_airbnb: boolean; expected_checkin_time: string | null;
    expected_checkout_time: string | null; cleaning_duration_minutes: number | null;
    booking_id: string | null; public_reference: string | null;
    completed_early_at: string | null; early_checkout_effective_date: string | null;
  }[]>`
    select e.id, e.property_id, e.listing_id, e.entry_type, e.start_date::text, e.end_date::text,
      e.private_booking_name, e.private_contact, e.private_note, e.payment_amount::text, e.sync_to_airbnb,
      o.expected_checkin_time::text, o.expected_checkout_time::text, o.cleaning_duration_minutes,
      e.booking_id, b.public_reference, e.completed_early_at::text,
      e.early_checkout_effective_date::text
    from public.local_calendar_entries e left join public.operation_overrides o on o.local_entry_id = e.id
    left join public.bookings b on b.id = e.booking_id
    where e.property_id in ${sql(propertyIds)}
      and (e.active or (e.completed_early_at is not null and e.archived_at is null))
      and e.start_date < ${viewEnd} and e.end_date > ${startDate}
  `;
  const holds = await sql<{
    id: string; property_id: string; public_reference: string; checkin: string; checkout: string; hold_expires_at: string;
  }[]>`
    select distinct b.id, b.property_id, b.public_reference, b.checkin::text, b.checkout::text,
      coalesce(i.expires_at, b.hold_expires_at)::text as hold_expires_at
    from public.bookings b
    join public.inventory_nights i on i.booking_id = b.id
      and i.source_kind = 'website_hold' and i.status = 'active'
    where b.property_id in ${sql(propertyIds)}
      and b.status in ('processing', 'held', 'payment_pending')
      and coalesce(i.expires_at, b.hold_expires_at) > now()
      and b.checkin < ${viewEnd} and b.checkout > ${startDate}
  `;
  const alertRows = await sql<{
    id: string; property_id: string; public_reference: string; cancellation_reason: string | null; refund_status: string;
  }[]>`
    select b.id, b.property_id, b.public_reference, b.cancellation_reason, b.refund_status
    from public.bookings b
    where b.property_id in ${sql(propertyIds)}
      and b.checkin < ${viewEnd} and b.checkout > ${startDate}
      and (b.refund_status = 'failed' or b.cancellation_reason = 'airbnb_collision')
    order by b.updated_at desc
  `;
  const entriesByProperty = new Map<string, CalendarEntry[]>();
  const add = (propertyId: string, entry: CalendarEntry) => entriesByProperty.set(propertyId, [...(entriesByProperty.get(propertyId) ?? []), entry]);
  const propertySync = new Map(properties.map((property) => [property.id, {
    lastSyncAt: property.last_sync_at,
    lastSyncStatus: property.last_sync_status,
  }]));
  const observedBusyDates = new Set(external
    .filter((row) => row.event_type === "unavailable")
    .map((row) => `${row.property_id}:${row.start_date}:${row.end_date}`));
  for (const row of external) add(row.property_id, {
    id: row.id, propertyId: row.property_id, listingId: row.listing_id, source: "airbnb", kind: row.event_type,
    label: row.event_type === "reservation" ? "Airbnb reservation" : row.event_type === "unavailable" ? "Airbnb unavailable" : "Airbnb event",
    startDate: row.start_date, endDate: row.end_date, privateBookingName: null, paymentAmount: null, privateContact: null,
    privateNote: row.operational_note, expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null,
    expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
    cleaningDurationMinutes: row.cleaning_duration_minutes, reservationUrl: row.sanitized_reservation_url,
    syncToAirbnb: false, airbnbObserved: false,
    completedEarlyAt: null, earlyCheckoutEffectiveDate: null,
    releaseObservedOnAirbnb: false, sameDayTurnover: false,
  });
  for (const row of local) {
    const completedEarly = Boolean(row.completed_early_at);
    const sync = propertySync.get(row.property_id);
    const oldBusyRangeStillPresent = external.some((externalRow) =>
      externalRow.property_id === row.property_id
      && externalRow.event_type === "unavailable"
      && externalRow.start_date < row.end_date
      && externalRow.end_date > row.start_date);
    const releaseObservedOnAirbnb = completedEarly
      && sync?.lastSyncStatus === "success"
      && Boolean(sync.lastSyncAt)
      && new Date(sync.lastSyncAt!).getTime() > new Date(row.completed_early_at!).getTime()
      && !oldBusyRangeStillPresent;
    add(row.property_id, {
      id: row.id, propertyId: row.property_id, listingId: row.listing_id, source: row.booking_id ? "website" : "local",
      kind: completedEarly ? "completed_early" : row.entry_type,
      label: completedEarly
        ? "Completed early"
        : row.booking_id
          ? `Website booking · ${row.public_reference}`
          : row.entry_type === "direct_reservation"
            ? row.private_booking_name?.trim() || "Direct reservation"
            : "Blocked",
      startDate: row.start_date, endDate: row.end_date, privateBookingName: row.booking_id ? null : row.private_booking_name,
      paymentAmount: row.booking_id ? null : row.payment_amount,
      privateContact: row.booking_id ? null : row.private_contact, privateNote: row.booking_id ? null : row.private_note,
      expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null,
      expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
      cleaningDurationMinutes: row.cleaning_duration_minutes, reservationUrl: null, syncToAirbnb: row.sync_to_airbnb,
      airbnbObserved: row.sync_to_airbnb && observedBusyDates.has(`${row.property_id}:${row.start_date}:${row.end_date}`),
      completedEarlyAt: row.completed_early_at,
      earlyCheckoutEffectiveDate: row.early_checkout_effective_date,
      releaseObservedOnAirbnb,
      sameDayTurnover: false,
      publicReference: row.public_reference, holdExpiresAt: null,
    });
  }
  for (const row of holds) add(row.property_id, {
    id: `website-hold:${row.id}`, propertyId: row.property_id, listingId: null, source: "website", kind: "payment_hold",
    label: "Payment in progress", startDate: row.checkin, endDate: row.checkout,
    privateBookingName: null, paymentAmount: null, privateContact: null, privateNote: null,
    expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null,
    reservationUrl: null, syncToAirbnb: false, airbnbObserved: false,
    completedEarlyAt: null, earlyCheckoutEffectiveDate: null,
    releaseObservedOnAirbnb: false, sameDayTurnover: false,
    publicReference: row.public_reference, holdExpiresAt: row.hold_expires_at,
  });
  for (const entries of entriesByProperty.values()) {
    const completedEntries = entries.filter((entry) => entry.kind === "completed_early");
    for (const reservation of entries.filter((entry) => entry.source === "airbnb" && entry.kind === "reservation")) {
      const overlappingHistory = completedEntries.filter((entry) =>
        entry.startDate < reservation.endDate && entry.endDate > reservation.startDate);
      if (overlappingHistory.length === 0) continue;
      reservation.label = "Same-day turnover · second booking";
      reservation.sameDayTurnover = true;
      for (const entry of overlappingHistory) entry.sameDayTurnover = true;
    }
  }
  const alertsByProperty = new Map<string, CalendarAlert[]>();
  for (const row of alertRows) {
    const alerts = alertsByProperty.get(row.property_id) ?? [];
    alerts.push({
      id: `booking-alert:${row.id}`,
      severity: row.refund_status === "failed" ? "error" : "warning",
      message: row.refund_status === "failed"
        ? `Refund failed for ${row.public_reference}`
        : `Airbnb collision cancelled ${row.public_reference} · refund ${row.refund_status.replaceAll("_", " ")}`,
    });
    alertsByProperty.set(row.property_id, alerts);
  }
  return properties.map((property) => ({
    id: property.id, name: property.name, defaultCheckinTime: property.default_checkin_time.slice(0, 5),
    defaultCheckoutTime: property.default_checkout_time.slice(0, 5), defaultCleaningMinutes: property.default_cleaning_minutes,
    lastSyncAt: property.last_sync_at, lastSyncStatus: property.last_sync_status,
    isStale: !property.last_sync_at || Date.now() - new Date(property.last_sync_at).getTime() > 30 * 60 * 1000,
    entries: entriesByProperty.get(property.id) ?? [], alerts: alertsByProperty.get(property.id) ?? [],
  }));
}

export function createCalendarService(sql: postgres.Sql) {
  return {
    getCalendarData(userId: string, startDate: string, days: number) {
      return getCalendarDataWithSql(sql, userId, startDate, days);
    },
  };
}

export async function getCalendarData(userId: string, startDate: string, days: number): Promise<CalendarProperty[]> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return demoCalendar(startDate);
  return getCalendarDataWithSql(getDb(), userId, startDate, days);
}

export async function getVacancySummaryForUser(userId: string, startDate: string, endDate: string) {
  calculateVacancy([], startDate, endDate);
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const properties = await getCalendarData(userId, startDate, days);
  return calculateVacancy(properties, startDate, endDate);
}
