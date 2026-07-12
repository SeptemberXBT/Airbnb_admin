import type { DerivedTurnover } from "./derive-turnovers";

export type DesiredCleaningTask = {
  propertyId: string;
  serviceDate: string;
  outgoingEntryKey: string | null;
  incomingEntryKey: string | null;
  releaseTime: string;
  readyDeadline: string;
  guestArrivalTime: string | null;
  durationMinutes: number;
};

export type CleaningTaskReconciliationStore = {
  archiveStale: (propertyIds: string[], serviceDate: string, desired: DesiredCleaningTask[]) => Promise<unknown>;
  upsertDerived: (desired: DesiredCleaningTask[]) => Promise<unknown>;
};

export async function reconcileCleaningTasks(
  store: CleaningTaskReconciliationStore,
  propertyIds: string[],
  serviceDate: string,
  tasks: DerivedTurnover[],
) {
  const desired = tasks.map((task) => ({
    propertyId: task.propertyId,
    serviceDate,
    outgoingEntryKey: task.outgoingEntryKey,
    incomingEntryKey: task.incomingEntryKey,
    releaseTime: task.releaseTime.toISOString(),
    readyDeadline: task.readyDeadline.toISOString(),
    guestArrivalTime: task.guestArrivalTime?.toISOString() ?? null,
    durationMinutes: task.durationMinutes,
  }));
  await store.archiveStale(propertyIds, serviceDate, desired);
  if (desired.length) await store.upsertDerived(desired);
}
