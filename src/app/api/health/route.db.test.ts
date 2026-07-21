import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createBookingReadiness } from "./route";

const NOW = new Date("2026-07-21T10:15:00.000Z");

describe("health readiness", () => {
  beforeEach(resetDb);

  it("reports coarse database and stale worker state without configuration names", async () => {
    const readiness = await createBookingReadiness(testSql, () => NOW);
    expect(readiness).toEqual({ status: "degraded", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "stale" });
    expect(JSON.stringify(readiness)).not.toMatch(/secret|razorpay|zeptomail|database_url/i);
  });

  it("reports ready only after a recent durable worker run", async () => {
    await testSql`
      insert into public.audit_log (action, entity_type, entity_id, created_at)
      values ('booking_worker_run', 'booking_worker', 'scheduled', '2026-07-21T10:13:01Z')
    `;
    await expect(createBookingReadiness(testSql, () => NOW)).resolves.toEqual({
      status: "ok", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "fresh",
    });
  });
});
