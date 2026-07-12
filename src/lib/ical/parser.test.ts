import { describe, expect, it } from "vitest";
import { parseAirbnbCalendar } from "./parser";

const calendar = (events: string) => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Synthetic Airbnb Test//EN",
  events,
  "END:VCALENDAR",
].join("\r\n");

describe("Airbnb iCalendar parser", () => {
  it("parses folded all-day reservations and preserves non-inclusive DTEND", () => {
    const result = parseAirbnbCalendar(calendar([
      "BEGIN:VEVENT",
      "UID:reservation-1@airbnb.com",
      "DTSTART;VALUE=DATE:20260714",
      "DTEND;VALUE=DATE:20260717",
      "SUMMARY:Reserved",
      "DESCRIPTION:Reservation details at https://www.airbnb.com/hosting/reserv",
      " ations/details/ABC123?secret=value",
      "END:VEVENT",
    ].join("\r\n")));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceUid: "reservation-1@airbnb.com",
      eventType: "reservation",
      startDate: "2026-07-14",
      endDate: "2026-07-17",
      sanitizedReservationUrl: "https://www.airbnb.com/hosting/reservations/details/ABC123",
    });
    expect(result[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("classifies unavailable and unknown events without leaking descriptions", () => {
    const result = parseAirbnbCalendar(calendar([
      "BEGIN:VEVENT\r\nUID:block-1\r\nDTSTART;VALUE=DATE:20260718\r\nDTEND;VALUE=DATE:20260719\r\nSUMMARY:Airbnb (Not available)\r\nDESCRIPTION:private text\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:unknown-1\r\nDTSTART;VALUE=DATE:20260720\r\nDTEND;VALUE=DATE:20260721\r\nSUMMARY:Maintenance\r\nEND:VEVENT",
    ].join("\r\n")));
    expect(result.map((event) => event.eventType)).toEqual(["unavailable", "unknown"]);
    expect(JSON.stringify(result)).not.toContain("private text");
  });

  it("deduplicates UIDs and excludes cancelled events", () => {
    const event = "BEGIN:VEVENT\r\nUID:same\r\nDTSTART;VALUE=DATE:20260722\r\nDTEND;VALUE=DATE:20260723\r\nSUMMARY:Reserved\r\nEND:VEVENT";
    const cancelled = "BEGIN:VEVENT\r\nUID:cancelled\r\nDTSTART;VALUE=DATE:20260724\r\nDTEND;VALUE=DATE:20260725\r\nSUMMARY:Reserved\r\nSTATUS:CANCELLED\r\nEND:VEVENT";
    expect(parseAirbnbCalendar(calendar(`${event}\r\n${event}\r\n${cancelled}`))).toHaveLength(1);
  });

  it("accepts an empty calendar and rejects malformed date ranges", () => {
    expect(parseAirbnbCalendar(calendar(""))).toEqual([]);
    expect(() => parseAirbnbCalendar(calendar("BEGIN:VEVENT\r\nUID:bad\r\nDTSTART;VALUE=DATE:20260725\r\nDTEND;VALUE=DATE:20260724\r\nSUMMARY:Reserved\r\nEND:VEVENT"))).toThrow("invalid_event_date_range");
  });
});
