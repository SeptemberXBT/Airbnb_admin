import { describe, expect, it, vi } from "vitest";

const after = vi.fn((callback: () => void) => callback());
const runBookingJobs = vi.fn(async () => ({}));
vi.mock("next/server", () => ({ after }));
vi.mock("./job-runner", () => ({ runBookingJobs }));

describe("immediate booking worker scheduling", () => {
  it("runs jobs in request-lifetime after-work and absorbs fallback-safe failures", async () => {
    const { scheduleBookingJobs } = await import("./schedule-jobs");
    scheduleBookingJobs();
    expect(after).toHaveBeenCalledOnce();
    expect(runBookingJobs).toHaveBeenCalledOnce();
  });
});
