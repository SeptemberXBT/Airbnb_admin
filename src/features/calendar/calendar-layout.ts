import { addDays, differenceInCalendarDays, parseISO } from "date-fns";

export function eventSpan(startDate: string, endDate: string, viewStartDate: string, days: number) {
  const viewStart = parseISO(viewStartDate);
  const viewEnd = addDays(viewStart, days);
  const start = parseISO(startDate) < viewStart ? viewStart : parseISO(startDate);
  const end = parseISO(endDate) > viewEnd ? viewEnd : parseISO(endDate);
  if (end <= viewStart || start >= viewEnd || end <= start) return null;
  return {
    column: differenceInCalendarDays(start, viewStart) + 1,
    span: differenceInCalendarDays(end, start),
  };
}

export function assignEventLanes<T extends { id: string; startDate: string; endDate: string }>(entries: T[]) {
  const laneEnds: string[] = [];
  return [...entries]
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id))
    .map((entry) => {
      let lane = laneEnds.findIndex((endDate) => endDate <= entry.startDate);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = entry.endDate;
      return { ...entry, lane };
    });
}
