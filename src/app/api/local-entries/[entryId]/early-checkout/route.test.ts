import { beforeEach, describe, expect, it, vi } from "vitest";

const completeEarlyCheckout = vi.fn();

vi.mock("@/features/calendar/early-checkout-service", () => ({
  EarlyCheckoutError: class EarlyCheckoutError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  completeEarlyCheckout,
}));
vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));

describe("early checkout route", () => {
  const entryId = "10000000-0000-4000-8000-000000000099";

  beforeEach(() => {
    completeEarlyCheckout.mockReset().mockResolvedValue({
      entryId,
      completedEarlyAt: "2026-08-15 08:30:00+00",
      earlyCheckoutEffectiveDate: "2026-08-15",
      idempotent: false,
    });
  });

  it("uses only the authenticated user and URL entry ID", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/local-entries/${entryId}/early-checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this body must never be parsed",
    }), { params: Promise.resolve({ entryId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      entryId,
      completedEarlyAt: "2026-08-15 08:30:00+00",
      earlyCheckoutEffectiveDate: "2026-08-15",
      idempotent: false,
    });
    expect(completeEarlyCheckout).toHaveBeenCalledWith(entryId, "user-1");
  });

  it("returns the stored result for an idempotent retry", async () => {
    completeEarlyCheckout.mockResolvedValue({
      entryId,
      completedEarlyAt: "2026-08-15 08:30:00+00",
      earlyCheckoutEffectiveDate: "2026-08-15",
      idempotent: true,
    });
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/local-entries/${entryId}/early-checkout`, {
      method: "POST",
    }), { params: Promise.resolve({ entryId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, idempotent: true });
  });

  it.each([
    ["FORBIDDEN", 403, "forbidden"],
    ["NOT_FOUND", 404, "not_found"],
    ["INELIGIBLE", 409, "ineligible_early_checkout"],
  ])("maps %s to HTTP %i", async (code, status, responseError) => {
    const { EarlyCheckoutError } = await import("@/features/calendar/early-checkout-service");
    completeEarlyCheckout.mockRejectedValue(new EarlyCheckoutError(code as never, status as never));
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/local-entries/${entryId}/early-checkout`, {
      method: "POST",
    }), { params: Promise.resolve({ entryId }) });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: responseError });
  });

  it("returns 400 for a malformed entry ID without invoking the service", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("https://admin.test/api/local-entries/not-a-uuid/early-checkout", {
      method: "POST",
    }), { params: Promise.resolve({ entryId: "not-a-uuid" }) });

    expect(response.status).toBe(400);
    expect(completeEarlyCheckout).not.toHaveBeenCalled();
  });

  it("fails closed on an unexpected service error", async () => {
    completeEarlyCheckout.mockRejectedValue(new Error("database unavailable"));
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/local-entries/${entryId}/early-checkout`, {
      method: "POST",
    }), { params: Promise.resolve({ entryId }) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "operation_failed" });
  });
});
