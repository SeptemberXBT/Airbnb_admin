import { getCleaningQueue } from "@/features/cleaning/cleaning-service";
import { TodayQueue } from "@/features/cleaning/today-queue";
import { requireUser } from "@/lib/auth/require-user";
import { sharedWorkspaceVersion } from "@/lib/shared-workspace-version";
import { formatInTimeZone } from "date-fns-tz";

export default async function TodayPage() {
  const user = await requireUser();
  const now = new Date();
  const serviceDate = formatInTimeZone(now, "Asia/Kolkata", "yyyy-MM-dd");
  const tasks = await getCleaningQueue(user.id, serviceDate, now);
  const queueVersion = sharedWorkspaceVersion(tasks);
  return (
    <div className="workspace workspace--queue">
      <TodayQueue
        key={queueVersion}
        tasks={tasks}
        serviceDate={serviceDate}
        dateLabel={formatInTimeZone(now, "Asia/Kolkata", "EEEE, d MMMM")}
        clock={formatInTimeZone(now, "Asia/Kolkata", "h:mm a")}
        demoMode={process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production"}
      />
    </div>
  );
}
