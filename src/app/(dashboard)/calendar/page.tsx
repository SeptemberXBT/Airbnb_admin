import { CalendarWorkspace } from "@/features/calendar/calendar-workspace";
import { getCalendarData } from "@/features/calendar/calendar-service";
import { requireUser } from "@/lib/auth/require-user";
import { formatInTimeZone } from "date-fns-tz";
import { addDays, format, parseISO } from "date-fns";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ start?: string; zoom?: string }> }) {
  const query = await searchParams;
  const zoom = Number(query.zoom) === 30 ? 30 : 14;
  const today = formatInTimeZone(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(query.start ?? "") ? query.start! : today;
  const startDate = format(addDays(parseISO(anchorDate), -7), "yyyy-MM-dd");
  const user = await requireUser();
  const properties = await getCalendarData(user.id, startDate, 28);
  return <CalendarWorkspace properties={properties} startDate={startDate} anchorDate={anchorDate} zoom={zoom} demoMode={process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production"} />;
}
