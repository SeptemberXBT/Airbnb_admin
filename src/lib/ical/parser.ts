import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import ICAL from "ical.js";

export type NormalizedCalendarEvent = {
  sourceUid: string;
  eventType: "reservation" | "unavailable" | "unknown";
  startDate: string;
  endDate: string;
  sanitizedReservationUrl: string | null;
  contentHash: string;
};

function indiaDate(value: InstanceType<typeof ICAL.Time>) {
  if (value.isDate) {
    return `${value.year.toString().padStart(4, "0")}-${value.month.toString().padStart(2, "0")}-${value.day.toString().padStart(2, "0")}`;
  }
  return formatInTimeZone(value.toJSDate(), "Asia/Kolkata", "yyyy-MM-dd");
}

function classify(summary: string): NormalizedCalendarEvent["eventType"] {
  const normalized = summary.trim().toLowerCase();
  if (normalized === "reserved" || normalized.includes("reservation")) return "reservation";
  if (normalized.includes("not available") || normalized === "unavailable") return "unavailable";
  return "unknown";
}

function sanitizeReservationUrl(description: string) {
  const match = description.match(/https:\/\/[^\s<>"']+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (!/(^|\.)airbnb\.[a-z.]+$/i.test(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function parseAirbnbCalendar(source: string): NormalizedCalendarEvent[] {
  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(source));
  } catch {
    throw new Error("feed_malformed");
  }
  if (root.name !== "vcalendar") throw new Error("feed_malformed");

  const byUid = new Map<string, NormalizedCalendarEvent>();
  for (const component of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);
    if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
    const sourceUid = event.uid?.trim();
    if (!sourceUid || !event.startDate || !event.endDate) throw new Error("invalid_event_fields");
    const startDate = indiaDate(event.startDate);
    const endDate = indiaDate(event.endDate);
    if (endDate <= startDate) throw new Error("invalid_event_date_range");
    const eventType = classify(event.summary ?? "");
    const sanitizedReservationUrl = sanitizeReservationUrl(event.description ?? "");
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ sourceUid, eventType, startDate, endDate, sanitizedReservationUrl }))
      .digest("hex");
    byUid.set(sourceUid, { sourceUid, eventType, startDate, endDate, sanitizedReservationUrl, contentHash });
  }
  return [...byUid.values()];
}
