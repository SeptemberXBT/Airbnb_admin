import { beforeEach, describe, expect, it, vi } from "vitest";

const removeTestBooking = vi.fn();

vi.mock("@/features/bookings/admin-test-cleanup-service", () => ({
  AdminTestCleanupError: class AdminTestCleanupError extends Error {
    constructor(public code: string, public httpStatus: number) { super(code); }
  },
  removeTestBooking,
}));
vi.mock("@/lib/auth/require-user", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));

describe("admin test-booking cleanup route", () => {
  const bookingId = "10000000-0000-4000-8000-000000000099";

  beforeEach(() => {
    removeTestBooking.mockReset().mockResolvedValue({ refundStatus: "not_required", archived: true });
  });

  it("requires the exact public reference and removes only through the guarded service", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/bookings/${bookingId}/remove-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicReference: "NH-BOOKING123456" }),
    }), { params: Promise.resolve({ bookingId }) });

    expect(response.status).toBe(200);
    expect(removeTestBooking).toHaveBeenCalledWith("user-1", bookingId, "NH-BOOKING123456");
  });

  it("rejects malformed confirmation without invoking the service", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/bookings/${bookingId}/remove-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicReference: "wrong" }),
    }), { params: Promise.resolve({ bookingId }) });
    expect(response.status).toBe(400);
    expect(removeTestBooking).not.toHaveBeenCalled();
  });
});
