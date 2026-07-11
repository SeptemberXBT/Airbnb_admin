import { describe, expect, it } from "vitest";
import { mapWithConcurrency, sanitizeSyncError, verifySyncSecret } from "./sync-security";

describe("sync security and concurrency", () => {
  it("requires an exact non-empty sync secret", () => {
    expect(verifySyncSecret("correct-secret", "correct-secret")).toBe(true);
    expect(verifySyncSecret("wrong-secret", "correct-secret")).toBe(false);
    expect(verifySyncSecret("", "correct-secret")).toBe(false);
    expect(verifySyncSecret("correct-secret", "")).toBe(false);
  });

  it("bounds concurrency and isolates individual failures", async () => {
    let active = 0;
    let maximum = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (value === 3) throw new Error("private URL https://example.test/secret.ics");
      return value * 2;
    });
    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
  });

  it("maps failures to allowlisted codes without secret text", () => {
    const safe = sanitizeSyncError(new Error("request failed for https://example.test/private.ics?s=secret"));
    expect(safe).toEqual({ code: "sync_failed", message: "Calendar synchronization failed" });
    expect(JSON.stringify(safe)).not.toContain("private.ics");
  });
});
