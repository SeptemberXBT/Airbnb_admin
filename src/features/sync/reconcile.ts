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
