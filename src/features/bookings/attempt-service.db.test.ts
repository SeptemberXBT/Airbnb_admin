import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createAttemptService } from "./attempt-service";

const REQUEST_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
let now: Date;

describe("booking attempt idempotency", () => {
  beforeEach(async () => {
    await resetDb();
    now = new Date("2026-07-21T10:00:00.000Z");
  });

  function service() {
    return createAttemptService(testSql, { clock: () => now });
  }

  it("atomically acquires once and returns 202 retry guidance for a live 60-second lease", async () => {
    const key = randomUUID();
    const results = await Promise.all([
      service().acquire(key, REQUEST_HASH),
      service().acquire(key, REQUEST_HASH),
    ]);
    expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "processing")).toEqual([
      { kind: "processing", retryAfterSeconds: 60 },
    ]);
  });

  it("rejects the same key with a changed request hash", async () => {
    const key = randomUUID();
    await service().acquire(key, REQUEST_HASH);
    expect(await service().acquire(key, OTHER_HASH)).toEqual({ kind: "conflict" });
  });

  it("replays terminal success for 30 minutes then retains an expired tombstone", async () => {
    const key = randomUUID();
    const acquired = await service().acquire(key, REQUEST_HASH);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    await service().completeTerminal(key, acquired.leaseToken, {
      status: "succeeded",
      httpStatus: 201,
      response: { publicReference: "NH-TESTTERMINAL1" },
    });

    expect(await service().acquire(key, REQUEST_HASH)).toEqual({
      kind: "replay", httpStatus: 201, response: { publicReference: "NH-TESTTERMINAL1" },
    });
    now = new Date(now.getTime() + 30 * 60_000 + 1);
    expect(await service().pruneExpiredReplayBodies()).toBe(1);
    expect(await service().acquire(key, REQUEST_HASH)).toEqual({ kind: "expired" });
    const [row] = await testSql<{ terminal_response: unknown; count: number }[]>`
      select terminal_response, count(*) over ()::int as count
      from public.booking_attempts where idempotency_key = ${key}
    `;
    expect(row).toEqual({ terminal_response: null, count: 1 });
  });

  it("atomically takes over a stale lease without losing its durable step", async () => {
    const key = randomUUID();
    const acquired = await service().acquire(key, REQUEST_HASH);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    await service().recordProgress(key, acquired.leaseToken, "hold_committed");
    now = new Date(now.getTime() + 60_001);

    const resumed = await service().acquire(key, REQUEST_HASH);
    expect(resumed).toMatchObject({ kind: "acquired", resumed: true, durableStep: "hold_committed" });
    if (resumed.kind !== "acquired") throw new Error("expected takeover");
    expect(resumed.leaseToken).not.toBe(acquired.leaseToken);
  });

  it("renews the 60-second lease whenever durable progress is recorded", async () => {
    const key = randomUUID();
    const acquired = await service().acquire(key, REQUEST_HASH);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    now = new Date(now.getTime() + 50_000);
    await service().recordProgress(key, acquired.leaseToken, "hold_committed");
    now = new Date(now.getTime() + 20_000);

    expect(await service().acquire(key, REQUEST_HASH)).toEqual({
      kind: "processing", retryAfterSeconds: 40,
    });
  });

  it("resumes retryable work from its last durable step", async () => {
    const key = randomUUID();
    const acquired = await service().acquire(key, REQUEST_HASH);
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    await service().recordProgress(key, acquired.leaseToken, "razorpay_receipt_lookup");
    await service().markRetryable(key, acquired.leaseToken);

    expect(await service().acquire(key, REQUEST_HASH)).toMatchObject({
      kind: "acquired", resumed: true, durableStep: "razorpay_receipt_lookup",
    });
  });
});
