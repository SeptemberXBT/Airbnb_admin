import { describe, expect, it } from "vitest";
import { generateOutboundCalendar } from "./outbound";

describe("outbound iCalendar generation", () => {
  it("publishes only generic busy dates with non-inclusive DTEND", () => {
    const sourceRecord = {
      id: "internal-entry-id",
      startDate: "2026-07-14",
      endDate: "2026-07-17",
      privateBookingName: "Private Guest",
      privateContact: "+91 99999 99999",
      privateNote: "Gate code 1234",
      sourceUrl: "https://airbnb.example/private",
    };
    const feed = generateOutboundCalendar([sourceRecord], "public-route-token", new Date("2026-07-11T10:00:00Z"));
    expect(feed).toContain("DTSTART;VALUE=DATE:20260714");
    expect(feed).toContain("DTEND;VALUE=DATE:20260717");
    expect(feed).toContain("SUMMARY:Busy");
    expect(feed).toContain("TRANSP:OPAQUE");
    for (const secret of ["internal-entry-id", "Private Guest", "+91", "Gate code", "airbnb.example"]) {
      expect(feed).not.toContain(secret);
    }
    expect(feed.split("\r\n").at(-1)).toBe("");
  });

  it("emits a valid empty calendar without imported records", () => {
    const feed = generateOutboundCalendar([], "token", new Date("2026-07-11T10:00:00Z"));
    expect(feed).toContain("BEGIN:VCALENDAR");
    expect(feed).toContain("END:VCALENDAR");
    expect(feed).not.toContain("BEGIN:VEVENT");
  });
});
