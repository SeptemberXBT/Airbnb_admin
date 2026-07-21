const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseStayDate(value: string) {
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

export function expandStayDates(startDate: string, endDate: string) {
  const cursor = parseStayDate(startDate);
  const end = parseStayDate(endDate);
  if (cursor >= end) throw new Error("INVALID_STAY_RANGE");
  const dates: string[] = [];
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
