import { addDays, differenceInCalendarDays, format, isValid, parseISO } from "date-fns";

export type VacancyEntry = {
  id: string;
  kind: string;
  startDate: string;
  endDate: string;
};

export type VacancyProperty = {
  id: string;
  name: string;
  isStale: boolean;
  entries: VacancyEntry[];
};

export type VacancySummary = {
  startDate: string;
  endDate: string;
  totalVacantRoomNights: number;
  hasStaleData: boolean;
  byDate: Array<{ date: string; vacantPropertyIds: string[]; stalePropertyIds: string[] }>;
  byProperty: Array<{ propertyId: string; propertyName: string; vacantNights: number; isStale: boolean }>;
};

export function calculateVacancy(properties: VacancyProperty[], startDate: string, endDate: string): VacancySummary {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  if (!isValid(start) || !isValid(end) || end < start) throw new Error("INVALID_RANGE");
  const nights = differenceInCalendarDays(end, start) + 1;
  if (nights > 366) throw new Error("RANGE_TOO_LARGE");

  const byDate = Array.from({ length: nights }, (_, index) => {
    const date = format(addDays(start, index), "yyyy-MM-dd");
    const vacant = properties.filter((property) => !property.entries.some((entry) =>
      entry.startDate <= date && entry.endDate > date));
    return {
      date,
      vacantPropertyIds: vacant.map((property) => property.id),
      stalePropertyIds: vacant.filter((property) => property.isStale).map((property) => property.id),
    };
  });
  const byProperty = properties.map((property) => ({
    propertyId: property.id,
    propertyName: property.name,
    vacantNights: byDate.filter((day) => day.vacantPropertyIds.includes(property.id)).length,
    isStale: property.isStale,
  }));

  return {
    startDate,
    endDate,
    totalVacantRoomNights: byProperty.reduce((total, property) => total + property.vacantNights, 0),
    hasStaleData: properties.some((property) => property.isStale),
    byDate,
    byProperty,
  };
}
