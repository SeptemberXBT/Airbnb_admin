import "server-only";
import { getDb } from "@/lib/db/client";
import { addDays, format, parseISO } from "date-fns";
import { buildManualBookingsCsv, type ManualExportEntry, type ManualExportProperty } from "./manual-booking-export";

export async function exportManualBookings(userId: string, startDate: string, endDate: string) {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") {
    return buildManualBookingsCsv([{ id: "demo", name: "Courtyard Studio" }], [{
      propertyId: "demo", startDate, endDate: format(addDays(parseISO(startDate), 1), "yyyy-MM-dd"),
      guestName: "Synthetic Guest", paymentAmount: "1000.00", entryType: "direct_reservation",
    }], startDate, endDate);
  }
  const sql = getDb();
  const properties = await sql<ManualExportProperty[]>`
    select p.id, p.name from public.properties p
    join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    where p.active and p.archived_at is null order by p.name, p.id
  `;
  const propertyIds = properties.map((property) => property.id);
  const endExclusive = format(addDays(parseISO(endDate), 1), "yyyy-MM-dd");
  const entries = propertyIds.length ? await sql<{
    property_id: string; start_date: string; end_date: string; private_booking_name: string | null;
    payment_amount: string | null; entry_type: "blocked" | "direct_reservation";
  }[]>`
    select e.property_id, e.start_date::text, e.end_date::text, e.private_booking_name,
      e.payment_amount::text, e.entry_type
    from public.local_calendar_entries e
    where e.property_id in ${sql(propertyIds)} and e.active
      and e.entry_type in ('blocked', 'direct_reservation')
      and e.start_date < ${endExclusive} and e.end_date > ${startDate}
    order by e.start_date, e.created_at, e.id
  ` : [];
  return buildManualBookingsCsv(properties, entries.map((entry): ManualExportEntry => ({
    propertyId: entry.property_id,
    startDate: entry.start_date,
    endDate: entry.end_date,
    guestName: entry.private_booking_name,
    paymentAmount: entry.payment_amount,
    entryType: entry.entry_type,
  })), startDate, endDate);
}
