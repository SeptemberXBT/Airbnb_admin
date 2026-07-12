import { addDays, formatISO } from "date-fns";
import type { CalendarEntry, CalendarProperty } from "./calendar-types";

const date = (start: string, days: number) => formatISO(addDays(new Date(`${start}T12:00:00+05:30`), days), { representation: "date" });

export function demoCalendar(startDate: string): CalendarProperty[] {
  const names = ["Courtyard Studio", "Mango Room", "Terrace Suite", "Garden Annex", "Library Loft"];
  return names.map((name, index) => {
    const propertyId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const entries: CalendarEntry[] = [
      {
        id: `demo-airbnb-${index}`,
        propertyId,
        listingId: `demo-listing-${index}`,
        source: "airbnb",
        kind: "reservation",
        label: "Airbnb reservation",
        startDate: date(startDate, index - 2),
        endDate: date(startDate, index + 1),
        privateBookingName: null,
        paymentAmount: null,
        privateContact: null,
        privateNote: index === 1 ? "Synthetic operational note" : null,
        expectedCheckinTime: index === 2 ? "12:00" : null,
        expectedCheckoutTime: null,
        cleaningDurationMinutes: null,
        reservationUrl: null,
        syncToAirbnb: false, airbnbObserved: false,
      },
    ];
    if (index === 0) entries.push({
      id: "demo-direct-1", propertyId, listingId: null, source: "local", kind: "direct_reservation",
      label: "Direct reservation", startDate: date(startDate, 5), endDate: date(startDate, 8),
      privateBookingName: "Synthetic Direct", paymentAmount: "12000.00", privateContact: null, privateNote: "Synthetic fixture only",
      expectedCheckinTime: "13:00", expectedCheckoutTime: "11:00", cleaningDurationMinutes: 20,
      reservationUrl: null, syncToAirbnb: true, airbnbObserved: false,
    });
    if (index === 3) entries.push({
      id: "demo-block-1", propertyId, listingId: null, source: "local", kind: "blocked",
      label: "Blocked", startDate: date(startDate, 3), endDate: date(startDate, 5),
      privateBookingName: null, paymentAmount: null, privateContact: null, privateNote: "Synthetic maintenance block",
      expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null,
      reservationUrl: null, syncToAirbnb: true, airbnbObserved: false,
    });
    return {
      id: propertyId, name, defaultCheckinTime: "13:00", defaultCheckoutTime: "11:00",
      defaultCleaningMinutes: 15, lastSyncAt: new Date().toISOString(), lastSyncStatus: "success", isStale: false, entries,
    };
  });
}
