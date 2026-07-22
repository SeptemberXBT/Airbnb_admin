import { after } from "next/server";
import { runBookingJobs } from "./job-runner";

export function scheduleBookingJobs() {
  after(async () => {
    try { await runBookingJobs(); } catch { /* Supabase cron is the durable fallback. */ }
  });
}
