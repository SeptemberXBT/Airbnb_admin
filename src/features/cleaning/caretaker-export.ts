import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

export type CaretakerExportTask = {
  propertyName: string;
  status: "queued" | "cleaning_now" | "ready" | "delayed" | "skipped";
  checkoutTime: string;
  checkinTime: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  durationMinutes: number;
};

const zone = "Asia/Kolkata";
const clock = (value: string | null) => value
  ? formatInTimeZone(new Date(value), zone, "h:mm a")
  : "--";
const localClock = (serviceDate: string, value: string) =>
  formatInTimeZone(fromZonedTime(`${serviceDate}T${value}:00`, zone), zone, "h:mm a");

export function formatCaretakerPlan(serviceDate: string, tasks: CaretakerExportTask[]) {
  const current = tasks.filter((task) => !["ready", "skipped"].includes(task.status));
  const heading = `Noir Haus cleaning - ${formatInTimeZone(fromZonedTime(`${serviceDate}T12:00:00`, zone), zone, "EEE, d MMM")}`;
  return [heading, ...current.map((task, index) =>
    `${index + 1}. ${task.propertyName} - checkout ${localClock(serviceDate, task.checkoutTime)} | clean ${clock(task.plannedStart)}-${clock(task.plannedEnd)} (${task.durationMinutes} min) | ${task.checkinTime ? `check-in ${localClock(serviceDate, task.checkinTime)}` : "no arrival"}`,
  )].join("\n");
}
