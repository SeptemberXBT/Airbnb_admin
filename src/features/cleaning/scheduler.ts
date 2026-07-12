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
  const byDeadline = (a: CleaningCandidate, b: CleaningCandidate) =>
    a.readyDeadline.getTime() - b.readyDeadline.getTime()
    || effectiveRelease(a).getTime() - effectiveRelease(b).getTime()
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
    let available = remaining.filter((task) => effectiveRelease(task) <= cursor).sort(byDeadline);
    if (!available.length) {
      const nextRelease = remaining.reduce((earliest, task) =>
        effectiveRelease(task) < earliest ? effectiveRelease(task) : earliest,
      effectiveRelease(remaining[0]));
      cursor = nextRelease;
      available = remaining.filter((task) => effectiveRelease(task) <= cursor).sort(byDeadline);
    }
    const task = available[0];
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
