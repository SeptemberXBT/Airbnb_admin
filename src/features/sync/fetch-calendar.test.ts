import { describe, expect, it, vi } from "vitest";
import { fetchCalendar } from "./fetch-calendar";

describe("calendar fetcher", () => {
  it("retries a transient failure and returns only bounded response text", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 }));
    const text = await fetchCalendar("https://www.airbnb.com/calendar/ical/test.ics?s=synthetic", { fetcher, retries: 1, timeoutMs: 100 });
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects non-success responses with a sanitized code", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("private response", { status: 403 }));
    await expect(fetchCalendar("https://www.airbnb.com/calendar/ical/test.ics?s=synthetic", { fetcher, retries: 0 })).rejects.toMatchObject({ code: "feed_http_403" });
  });

  it("rejects oversized feeds", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("x".repeat(2_000), { status: 200 }));
    await expect(fetchCalendar("https://www.airbnb.com/calendar/ical/test.ics?s=synthetic", { fetcher, retries: 0, maxBytes: 1000 })).rejects.toMatchObject({ code: "feed_too_large" });
  });

  it("blocks redirects away from Airbnb calendar exports", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }));
    await expect(fetchCalendar("https://www.airbnb.com/calendar/ical/test.ics?s=synthetic", { fetcher, retries: 0 })).rejects.toMatchObject({ code: "feed_redirect_blocked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
