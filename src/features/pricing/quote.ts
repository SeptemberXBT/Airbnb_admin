export type PropertyRates = {
  weekdayPricePaise: number;
  weekendPricePaise: number;
};

export type NightQuote = {
  date: string;
  amountPaise: number;
  source: "override" | "weekend" | "weekday";
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseStayDate(value: string) {
  if (!DATE_ONLY.test(value)) throw new Error("INVALID_STAY_DATE");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new Error("INVALID_STAY_DATE");
  return date;
}

function formatStayDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function assertPositivePaise(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("INVALID_PRICE");
}

export function enumerateStayDates(checkin: string, checkout: string) {
  const cursor = parseStayDate(checkin);
  const end = parseStayDate(checkout);
  if (cursor >= end) throw new Error("INVALID_STAY_RANGE");

  const dates: string[] = [];
  while (cursor < end) {
    dates.push(formatStayDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function priceNight(date: string, rates: PropertyRates, overrides: Map<string, number>): NightQuote {
  const stayDate = parseStayDate(date);
  const override = overrides.get(date);
  if (override !== undefined) {
    assertPositivePaise(override);
    return { date, amountPaise: override, source: "override" };
  }

  const day = stayDate.getUTCDay();
  const weekend = day === 5 || day === 6;
  const amountPaise = weekend ? rates.weekendPricePaise : rates.weekdayPricePaise;
  assertPositivePaise(amountPaise);
  return { date, amountPaise, source: weekend ? "weekend" : "weekday" };
}

export function buildQuote(dates: string[], rates: PropertyRates, overrides: Map<string, number>) {
  if (dates.length === 0) throw new Error("INVALID_STAY_RANGE");
  const nights = dates.map((date) => priceNight(date, rates, overrides));
  const totalPaise = nights.reduce((total, night) => total + night.amountPaise, 0);
  if (!Number.isSafeInteger(totalPaise)) throw new Error("INVALID_PRICE");
  return { currency: "INR" as const, nights, totalPaise };
}
