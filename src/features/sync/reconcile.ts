import type { NormalizedCalendarEvent } from "@/lib/ical/parser";

export type ExistingCalendarEvent = {
  id: string;
  sourceUid: string;
  contentHash: string;
  active: boolean;
};

export function planReconciliation(existing: ExistingCalendarEvent[], incoming: NormalizedCalendarEvent[]) {
  const existingByUid = new Map(existing.map((event) => [event.sourceUid, event]));
  const incomingUids = new Set(incoming.map((event) => event.sourceUid));
  const create: NormalizedCalendarEvent[] = [];
  const update: Array<{ existingId: string; event: NormalizedCalendarEvent }> = [];

  for (const event of incoming) {
    const record = existingByUid.get(event.sourceUid);
    if (!record) create.push(event);
    else if (!record.active || record.contentHash !== event.contentHash) update.push({ existingId: record.id, event });
  }
  const archive = existing.filter((event) => event.active && !incomingUids.has(event.sourceUid)).map((event) => event.id);
  return { create, update, archive };
}
