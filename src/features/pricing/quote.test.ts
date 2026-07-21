import { describe, expect, it } from "vitest";
import { buildQuote, enumerateStayDates, priceNight } from "./quote";

const rates = {
  weekdayPricePaise: 500000,
  weekendPricePaise: 650000,
};

describe("authoritative stay pricing", () => {
  it("classifies Friday and Saturday as weekend, with Sunday returning to weekday", () => {
    expect(priceNight("2026-08-07", rates, new Map()).source).toBe("weekend");
    expect(priceNight("2026-08-08", rates, new Map()).source).toBe("weekend");
    expect(priceNight("2026-08-09", rates, new Map()).source).toBe("weekday");
  });

  it("uses a date override ahead of the weekend rate", () => {
    expect(priceNight("2026-08-08", rates, new Map([["2026-08-08", 123400]]))).toEqual({
      date: "2026-08-08",
      amountPaise: 123400,
      source: "override",
    });
  });

  it("enumerates checkout-exclusive India stay dates", () => {
    expect(enumerateStayDates("2026-08-07", "2026-08-10")).toEqual([
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  it("builds the complete quote in integer paise", () => {
    expect(buildQuote(
      enumerateStayDates("2026-08-07", "2026-08-10"),
      rates,
      new Map([["2026-08-08", 700000]]),
    )).toEqual({
      currency: "INR",
      nights: [
        { date: "2026-08-07", amountPaise: 650000, source: "weekend" },
        { date: "2026-08-08", amountPaise: 700000, source: "override" },
        { date: "2026-08-09", amountPaise: 500000, source: "weekday" },
      ],
      totalPaise: 1850000,
    });
  });

  it("rejects invalid and empty stay ranges", () => {
    expect(() => enumerateStayDates("2026-08-08", "2026-08-08")).toThrow("INVALID_STAY_RANGE");
    expect(() => enumerateStayDates("not-a-date", "2026-08-09")).toThrow("INVALID_STAY_DATE");
  });
});
