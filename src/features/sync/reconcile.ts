import type { NormalizedCalendarEvent } from "@/lib/ical/parser";

export type ExistingCalendarEvent = {
  id: string;
  sourceUid: string;
  contentHash: string;
  startDate: string;
  endDate: string;
  active: boolean;
  historical: boolean;
};

export function affectedReconciliationBounds(
  existing: Array<Pick<ExistingCalendarEvent, "startDate" | "endDate">>,
  incoming: Array<Pick<NormalizedCalendarEvent, "startDate" | "endDate">>,
) {
  const ranges = [...existing, ...incoming];
  if (ranges.length === 0) return null;
  return {
    startDate: ranges.reduce((earliest, event) => event.startDate < earliest ? event.startDate : earliest, ranges[0].startDate),
    endDate: ranges.reduce((latest, event) => event.endDate > latest ? event.endDate : latest, ranges[0].endDate),
  };
}

export function planReconciliation(
  existing: ExistingCalendarEvent[],
  incoming: NormalizedCalendarEvent[],
  todayDate: string,
) {
  const existingByUid = new Map(existing.map((event) => [event.sourceUid, event]));
  const incomingUids = new Set(incoming.map((event) => event.sourceUid));
  const create: NormalizedCalendarEvent[] = [];
  const update: Array<{ existingId: string; event: NormalizedCalendarEvent }> = [];

  for (const event of incoming) {
    const record = existingByUid.get(event.sourceUid);
    if (!record) create.push(event);
    else if (!record.active || record.historical || record.contentHash !== event.contentHash) {
      update.push({ existingId: record.id, event });
    }
  }
  const missingActive = existing.filter((event) => event.active && !incomingUids.has(event.sourceUid));
  const archive = missingActive.filter((event) => event.endDate > todayDate).map((event) => event.id);
  const retainHistory = missingActive.filter((event) => event.endDate <= todayDate).map((event) => event.id);
  return { create, update, archive, retainHistory };
}
