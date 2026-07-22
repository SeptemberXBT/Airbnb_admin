import { beforeEach, describe, expect, it, vi } from "vitest";

const refundCancelAndArchiveBooking = vi.fn();
const scheduleBookingJobs = vi.fn();

vi.mock("@/features/bookings/admin-refund-service", () => ({
  AdminRefundError: class AdminRefundError extends Error {
    constructor(public code: string, public httpStatus: number) { super(code); }
  },
  refundCancelAndArchiveBooking,
}));
vi.mock("@/features/bookings/schedule-jobs", () => ({ scheduleBookingJobs }));
vi.mock("@/lib/auth/require-user", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));

describe("admin full refund route", () => {
  const bookingId = "10000000-0000-4000-8000-000000000099";
  beforeEach(() => {
    refundCancelAndArchiveBooking.mockReset().mockResolvedValue({ refundStatus: "pending", archived: true });
    scheduleBookingJobs.mockReset();
  });

  it("requires the exact public reference and starts the worker immediately", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/bookings/${bookingId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicReference: "NH-BOOKING123456" }),
    }), { params: Promise.resolve({ bookingId }) });

    expect(response.status).toBe(202);
    expect(refundCancelAndArchiveBooking).toHaveBeenCalledWith("user-1", bookingId, "NH-BOOKING123456");
    expect(scheduleBookingJobs).toHaveBeenCalledOnce();
  });

  it("rejects malformed confirmation without mutating a booking", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request(`https://admin.test/api/bookings/${bookingId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicReference: "wrong" }),
    }), { params: Promise.resolve({ bookingId }) });
    expect(response.status).toBe(400);
    expect(refundCancelAndArchiveBooking).not.toHaveBeenCalled();
  });

  it("accepts the maximum-length public booking reference", async () => {
    const { POST } = await import("./route");
    const publicReference = `NH-${"A".repeat(32)}`;
    const response = await POST(new Request(`https://admin.test/api/bookings/${bookingId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicReference }),
    }), { params: Promise.resolve({ bookingId }) });
    expect(response.status).toBe(202);
    expect(refundCancelAndArchiveBooking).toHaveBeenCalledWith("user-1", bookingId, publicReference);
  });
});
