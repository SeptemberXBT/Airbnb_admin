import { createHash } from "node:crypto";

type LocalBusyEntry = {
  id: string;
  startDate: string;
  endDate: string;
};

function compactDate(value: string) {
  return value.replaceAll("-", "");
}

function timestamp(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function generateOutboundCalendar(entries: LocalBusyEntry[], routeToken: string, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Haven Operations//Availability//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Haven Busy Dates",
  ];
  for (const entry of entries) {
    const opaqueUid = createHash("sha256").update(`${routeToken}:${entry.id}`).digest("hex").slice(0, 32);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${opaqueUid}@haven-operations`,
      `DTSTAMP:${timestamp(now)}`,
      `DTSTART;VALUE=DATE:${compactDate(entry.startDate)}`,
      `DTEND;VALUE=DATE:${compactDate(entry.endDate)}`,
      "SUMMARY:Busy",
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}
