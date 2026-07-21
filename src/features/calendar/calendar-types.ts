export type CalendarEntry = {
  id: string;
  propertyId: string;
  listingId: string | null;
  source: "airbnb" | "local" | "website";
  kind: "reservation" | "unavailable" | "unknown" | "direct_reservation" | "blocked" | "payment_hold";
  label: string;
  startDate: string;
  endDate: string;
  privateBookingName: string | null;
  paymentAmount: string | null;
  privateContact: string | null;
  privateNote: string | null;
  expectedCheckinTime: string | null;
  expectedCheckoutTime: string | null;
  cleaningDurationMinutes: number | null;
  reservationUrl: string | null;
  syncToAirbnb: boolean;
  airbnbObserved: boolean;
  publicReference?: string | null;
  holdExpiresAt?: string | null;
};

export type CalendarAlert = {
  id: string;
  severity: "warning" | "error";
  message: string;
};

export type CalendarProperty = {
  id: string;
  name: string;
  defaultCheckinTime: string;
  defaultCheckoutTime: string;
  defaultCleaningMinutes: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  isStale: boolean;
  entries: CalendarEntry[];
  alerts?: CalendarAlert[];
};
