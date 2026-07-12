import { addDays, format, isBefore, parseISO } from "date-fns";

export type ManualExportProperty = { id: string; name: string };
export type ManualExportEntry = {
  propertyId: string;
  startDate: string;
  endDate: string;
  guestName: string | null;
  paymentAmount: string | null;
  entryType?: "blocked" | "direct_reservation";
};

const dates = (startDate: string, endDateExclusive: string) => {
  const result: string[] = [];
  for (let day = parseISO(startDate); isBefore(day, parseISO(endDateExclusive)); day = addDays(day, 1)) {
    result.push(format(day, "yyyy-MM-dd"));
  }
  return result;
};

function parsePaise(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

export function splitPaymentAcrossNights(amount: string, startDate: string, endDate: string): Array<[string, number]> {
  const nights = dates(startDate, endDate);
  if (!nights.length) return [];
  const total = parsePaise(amount);
  const base = Math.floor(total / nights.length);
  const remainder = total % nights.length;
  return nights.map((night, index) => [night, base + (index < remainder ? 1 : 0)]);
}

export function formatInr(paise: number) {
  return `INR ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;
}

const protectFormula = (value: string) => /^[=+\-@]/.test(value) ? `'${value}` : value;
const csvField = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function entryValue(entry: ManualExportEntry, date: string) {
  const guest = entry.guestName?.trim() ? protectFormula(entry.guestName.trim()) : "";
  const payments = entry.paymentAmount ? new Map(splitPaymentAcrossNights(entry.paymentAmount, entry.startDate, entry.endDate)) : null;
  const payment = payments?.get(date);
  if (guest && payment !== undefined) return `${guest} - ${formatInr(payment)}`;
  if (guest) return guest;
  if (payment !== undefined) return formatInr(payment);
  return entry.entryType === "direct_reservation" ? "Direct reservation" : entry.entryType === "blocked" ? "Blocked" : "Manual entry";
}

export function buildManualBookingsCsv(
  properties: ManualExportProperty[],
  entries: ManualExportEntry[],
  startDate: string,
  endDate: string,
) {
  const orderedProperties = [...properties].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const exportDates = dates(startDate, format(addDays(parseISO(endDate), 1), "yyyy-MM-dd"));
  const rows = [
    ["Date", ...orderedProperties.map((property) => protectFormula(property.name))],
    ...exportDates.map((date) => [
      date,
      ...orderedProperties.map((property) => entries
        .filter((entry) => entry.propertyId === property.id && entry.startDate <= date && entry.endDate > date)
        .map((entry) => entryValue(entry, date))
        .join(" | ")),
    ]),
  ];
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}
