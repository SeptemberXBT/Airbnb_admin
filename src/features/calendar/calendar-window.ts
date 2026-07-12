import type { CalendarProperty } from "./calendar-types";

export function calendarWindowVersion(properties: CalendarProperty[]) {
  return JSON.stringify(
    [...properties]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((property) => ({
        ...property,
        entries: [...property.entries].sort((a, b) => a.id.localeCompare(b.id)),
      })),
  );
}

export function mergeCalendarWindows(current: CalendarProperty[], incoming: CalendarProperty[]) {
  const byProperty = new Map(current.map((property) => [property.id, property]));
  for (const property of incoming) {
    const existing = byProperty.get(property.id);
    if (!existing) {
      byProperty.set(property.id, property);
      continue;
    }
    const entries = new Map(existing.entries.map((entry) => [entry.id, entry]));
    for (const entry of property.entries) entries.set(entry.id, entry);
    byProperty.set(property.id, {
      ...existing,
      ...property,
      entries: [...entries.values()].sort((a, b) =>
        a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id)),
    });
  }
  return [...byProperty.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function trimCalendarWindow(properties: CalendarProperty[], startDate: string, endDate: string) {
  return properties.map((property) => ({
    ...property,
    entries: property.entries.filter((entry) => entry.startDate < endDate && entry.endDate > startDate),
  }));
}
