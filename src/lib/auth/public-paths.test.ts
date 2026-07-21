import { describe, expect, it } from "vitest";

describe("public path policy", () => {
  it("allows only login, auth callback, health, secret-protected cron, and tokenized iCal paths", async () => {
    let isPublicPath: ((path: string) => boolean) | undefined;
    try {
      isPublicPath = (await import("./public-paths")).isPublicPath;
    } catch {
      isPublicPath = undefined;
    }

    expect(isPublicPath?.("/login")).toBe(true);
    expect(isPublicPath?.("/auth/callback")).toBe(true);
    expect(isPublicPath?.("/api/health")).toBe(true);
    expect(isPublicPath?.("/api/sync/cron")).toBe(true);
    expect(isPublicPath?.("/api/bookings/cron")).toBe(true);
    expect(isPublicPath?.("/api/ical/random-token.ics")).toBe(true);
    expect(isPublicPath?.("/api/internal/v1/availability")).toBe(true);
    expect(isPublicPath?.("/api/internal/v1/bookings/NH-REFERENCE/reconcile")).toBe(true);
    expect(isPublicPath?.("/api/webhooks/razorpay")).toBe(true);
    expect(isPublicPath?.("/api/internal/v10/availability")).toBe(false);
    expect(isPublicPath?.("/api/internal/v1evil")).toBe(false);
    expect(isPublicPath?.("/api/webhooks/razorpay/extra")).toBe(false);
    expect(isPublicPath?.("/calendar")).toBe(false);
    expect(isPublicPath?.("/api/properties")).toBe(false);
  });
});
