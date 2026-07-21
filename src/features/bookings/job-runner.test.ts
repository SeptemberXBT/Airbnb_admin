import { describe, expect, it, vi } from "vitest";
import { createBookingJobRunner } from "./job-runner";

const NOW = new Date("2026-07-21T10:15:00.000Z");

function stage(processed: number, failed = 0) {
  return vi.fn(async () => ({ processed, failed }));
}

describe("booking job runner", () => {
  it("runs every bounded stage with a fixed clock and records count-only freshness", async () => {
    const dependencies = {
      expiredHolds: stage(2),
      paymentReconciliation: stage(3, 1),
      refunds: stage(4),
      notifications: stage(5),
      nonceCleanup: stage(6),
      staleLeaseRecovery: stage(7),
      replayBodyCleanup: stage(8),
      recordRun: vi.fn(async () => undefined),
    };
    const runner = createBookingJobRunner(dependencies, { clock: () => NOW, batchLimit: 25 });

    const result = await runner.run();

    for (const dependency of Object.values(dependencies).slice(0, -1)) {
      expect(dependency).toHaveBeenCalledWith({ now: NOW, limit: 25 });
    }
    expect(result).toEqual({
      expiredHolds: { processed: 2, failed: 0 },
      paymentReconciliation: { processed: 3, failed: 1 },
      refunds: { processed: 4, failed: 0 },
      notifications: { processed: 5, failed: 0 },
      nonceCleanup: { processed: 6, failed: 0 },
      staleLeaseRecovery: { processed: 7, failed: 0 },
      replayBodyCleanup: { processed: 8, failed: 0 },
      stageFailures: 0,
    });
    expect(dependencies.recordRun).toHaveBeenCalledWith(NOW, result);
    expect(JSON.stringify(result)).not.toMatch(/email|guest|token|secret/i);
  });

  it("does not abort unrelated stages when one stage throws", async () => {
    const notifications = stage(1);
    const dependencies = {
      expiredHolds: vi.fn(async () => { throw new Error("provider leaked detail"); }),
      paymentReconciliation: stage(1),
      refunds: stage(1),
      notifications,
      nonceCleanup: stage(1),
      staleLeaseRecovery: stage(1),
      replayBodyCleanup: stage(1),
      recordRun: vi.fn(async () => undefined),
    };

    const result = await createBookingJobRunner(dependencies, { clock: () => NOW, batchLimit: 10 }).run();

    expect(notifications).toHaveBeenCalled();
    expect(result.expiredHolds).toEqual({ processed: 0, failed: 1 });
    expect(result.stageFailures).toBe(1);
    expect(JSON.stringify(result)).not.toContain("provider leaked detail");
  });
});
