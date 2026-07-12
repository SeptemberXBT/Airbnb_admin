import { CalendarWorkspace } from "@/features/calendar/calendar-workspace";
import { getCalendarData } from "@/features/calendar/calendar-service";
import { requireUser } from "@/lib/auth/require-user";
import { formatInTimeZone } from "date-fns-tz";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ start?: string; range?: string }> }) {
  const query = await searchParams;
  const range = [7, 14, 30, 90].includes(Number(query.range)) ? Number(query.range) : 14;
  const today = formatInTimeZone(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(query.start ?? "") ? query.start! : today;
  const user = await requireUser();
  const properties = await getCalendarData(user.id, startDate, range);
  return <CalendarWorkspace properties={properties} startDate={startDate} days={range} demoMode={process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production"} />;
}
