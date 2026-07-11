import { getCleaningQueue } from "@/features/cleaning/cleaning-service";
import { TodayQueue } from "@/features/cleaning/today-queue";
import { requireUser } from "@/lib/auth/require-user";
import { formatInTimeZone } from "date-fns-tz";

export default async function TodayPage() {
  const user = await requireUser();
  const now = new Date();
  const serviceDate = formatInTimeZone(now, "Asia/Kolkata", "yyyy-MM-dd");
  const tasks = await getCleaningQueue(user.id, serviceDate, now);
  return (
    <div className="workspace workspace--queue">
      <header className="page-header"><div><p className="eyebrow">{formatInTimeZone(now, "Asia/Kolkata", "EEEE, d MMMM")}</p><h1>Today&apos;s cleaning</h1></div><span className="queue-clock">IST · {formatInTimeZone(now, "Asia/Kolkata", "h:mm a")}</span></header>
      <TodayQueue tasks={tasks} demoMode={process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production"} />
    </div>
  );
}
