import { beforeEach, describe, expect, it, vi } from "vitest";

const getOutboundCalendar = vi.fn();

vi.mock("@/features/calendar/outbound-service", () => ({ getOutboundCalendar }));

describe("outbound iCal route", () => {
  const token = "a".repeat(48);

  beforeEach(() => {
    getOutboundCalendar.mockReset().mockResolvedValue("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  });

  it("prevents application and edge caching of released inventory", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`https://admin.test/api/ical/${token}.ics`), {
      params: Promise.resolve({ token: `${token}.ics` }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(getOutboundCalendar).toHaveBeenCalledWith(token);
  });

  it("does not query storage for a malformed public token", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://admin.test/api/ical/short.ics"), {
      params: Promise.resolve({ token: "short.ics" }),
    });

    expect(response.status).toBe(404);
    expect(getOutboundCalendar).not.toHaveBeenCalled();
  });
});
