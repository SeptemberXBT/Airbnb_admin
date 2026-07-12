import { addMinutes } from "date-fns";

export type CleaningStatus = "queued" | "cleaning_now" | "ready" | "delayed" | "skipped";
export type WarningLevel = "safe" | "tight" | "impossible" | "overdue" | "waiting";

export type CleaningCandidate = {
  id: string;
  propertyId: string;
  propertyName: string;
  releaseTime: Date;
  readyDeadline: Date;
  guestArrivalTime: Date | null;
  durationMinutes: number;
  status: CleaningStatus;
  actualStart: Date | null;
  actualEnd: Date | null;
  delayMinutes: number;
};

export type ScheduledCleaningTask = CleaningCandidate & {
  plannedStart: Date | null;
  plannedEnd: Date | null;
  warningLevel: WarningLevel;
};

const later = (a: Date, b: Date) => a > b ? a : b;

function warning(task: CleaningCandidate, plannedEnd: Date | null, now: Date): WarningLevel {
  if (task.status === "ready" || task.status === "skipped") return "safe";
  if (now > task.readyDeadline) return "overdue";
  if (now < addMinutes(task.releaseTime, task.delayMinutes) && task.status !== "cleaning_now") return "waiting";
  if (plannedEnd && task.guestArrivalTime && plannedEnd > task.guestArrivalTime) return "impossible";
  if (plannedEnd && plannedEnd > task.readyDeadline) return "tight";
  return "safe";
}

export function buildCleaningSchedule(candidates: CleaningCandidate[], now: Date): ScheduledCleaningTask[] {
  const running = candidates
    .filter((task) => task.status === "cleaning_now")
    .sort((a, b) => (a.actualStart?.getTime() ?? 0) - (b.actualStart?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const finished = candidates.filter((task) => task.status === "ready" || task.status === "skipped");
  const queued = candidates.filter((task) => !["cleaning_now", "ready", "skipped"].includes(task.status));
  const effectiveRelease = (task: CleaningCandidate) => addMinutes(task.releaseTime, task.delayMinutes);
  const stableOrder = (a: CleaningCandidate, b: CleaningCandidate) =>
    a.propertyName.localeCompare(b.propertyName)
    || a.id.localeCompare(b.id);
  const byArrival = (a: CleaningCandidate, b: CleaningCandidate) =>
    (a.guestArrivalTime?.getTime() ?? 0) - (b.guestArrivalTime?.getTime() ?? 0)
    || effectiveRelease(a).getTime() - effectiveRelease(b).getTime()
    || stableOrder(a, b);
  const byRelease = (a: CleaningCandidate, b: CleaningCandidate) =>
    effectiveRelease(a).getTime() - effectiveRelease(b).getTime()
    || a.propertyName.localeCompare(b.propertyName)
    || a.id.localeCompare(b.id);

  let cursor = new Date(now);
  const scheduled: ScheduledCleaningTask[] = [];
  for (const task of running) {
    const plannedStart = task.actualStart ?? cursor;
    const plannedEnd = addMinutes(plannedStart, task.durationMinutes);
    cursor = later(cursor, plannedEnd);
    scheduled.push({ ...task, plannedStart, plannedEnd, warningLevel: warning(task, plannedEnd, now) });
  }
  const remaining = [...queued];
  while (remaining.length) {
    const arriving = remaining.filter((task) => task.guestArrivalTime);
    const availableArriving = arriving
      .filter((task) => effectiveRelease(task) <= cursor)
      .sort(byArrival);
    let task = availableArriving[0];

    if (!task && arriving.length) {
      const nextArrivalRelease = arriving.reduce((earliest, candidate) =>
        effectiveRelease(candidate) < earliest ? effectiveRelease(candidate) : earliest,
      effectiveRelease(arriving[0]));
      const gapTask = remaining
        .filter((candidate) => !candidate.guestArrivalTime
          && effectiveRelease(candidate) <= cursor
          && addMinutes(cursor, candidate.durationMinutes) <= nextArrivalRelease)
        .sort(byRelease)[0];
      if (gapTask) task = gapTask;
      else {
        cursor = nextArrivalRelease;
        continue;
      }
    }

    if (!task) {
      const availableNoArrival = remaining
        .filter((candidate) => effectiveRelease(candidate) <= cursor)
        .sort(byRelease);
      task = availableNoArrival[0];
      if (!task) {
        cursor = remaining.reduce((earliest, candidate) =>
          effectiveRelease(candidate) < earliest ? effectiveRelease(candidate) : earliest,
        effectiveRelease(remaining[0]));
        continue;
      }
    }
    remaining.splice(remaining.findIndex((candidate) => candidate.id === task.id), 1);
    const plannedStart = new Date(cursor);
    const plannedEnd = addMinutes(plannedStart, task.durationMinutes);
    cursor = plannedEnd;
    scheduled.push({ ...task, plannedStart, plannedEnd, warningLevel: warning(task, plannedEnd, now) });
  }
  for (const task of finished.sort((a, b) => (a.actualEnd?.getTime() ?? 0) - (b.actualEnd?.getTime() ?? 0))) {
    scheduled.push({ ...task, plannedStart: task.actualStart, plannedEnd: task.actualEnd, warningLevel: "safe" });
  }
  return scheduled;
}
