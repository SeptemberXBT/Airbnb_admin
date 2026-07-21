import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runBookingJobs = vi.fn();
vi.mock("@/features/bookings/job-runner", () => ({ runBookingJobs }));

describe("booking cron route", () => {
  beforeEach(() => {
    vi.resetModules();
    runBookingJobs.mockReset();
    vi.stubEnv("BOOKING_CRON_SECRET", "booking-cron-test-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects missing or incorrect bearer secrets without running jobs", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("https://admin.test/api/bookings/cron", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
    }));
    expect(response.status).toBe(401);
    expect(runBookingJobs).not.toHaveBeenCalled();
  });

  it("returns only structured counts for an authorized run", async () => {
    const counts = {
      expiredHolds: { processed: 1, failed: 0 }, paymentReconciliation: { processed: 1, failed: 0 },
      refunds: { processed: 0, failed: 0 }, notifications: { processed: 2, failed: 0 },
      nonceCleanup: { processed: 3, failed: 0 }, staleLeaseRecovery: { processed: 0, failed: 0 },
      replayBodyCleanup: { processed: 0, failed: 0 }, stageFailures: 0,
    };
    runBookingJobs.mockResolvedValue(counts);
    const { POST } = await import("./route");
    const response = await POST(new Request("https://admin.test/api/bookings/cron", {
      method: "POST",
      headers: { authorization: "Bearer booking-cron-test-secret" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(counts);
    expect(JSON.stringify(body)).not.toMatch(/secret|guest|email/i);
  });
});
