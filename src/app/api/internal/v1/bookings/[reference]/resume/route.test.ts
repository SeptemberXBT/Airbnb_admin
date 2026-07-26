import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingResumeServiceError } from "@/features/bookings/booking-resume-service";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const resume = vi.hoisted(() => vi.fn());
const configuredBookingRecoveryService = vi.hoisted(() =>
  vi.fn(() => ({ resume })),
);
const getPublicBookingStatus = vi.hoisted(() => vi.fn());
const scheduleBookingJobs = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/internal-api/request-auth")
  >()),
  authenticateInternalRequest,
}));
vi.mock("@/features/bookings/booking-recovery-service", () => ({
  configuredBookingRecoveryService,
}));
vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  getPublicBookingStatus,
}));
vi.mock("@/features/bookings/schedule-jobs", () => ({
  scheduleBookingJobs,
}));

const reference = "NH-RESUMEROUTE01";
const resumeToken = "A".repeat(43);

function request(
  body: unknown = { resumeToken },
  version?: string,
) {
  return new Request(
    `https://admin.test/api/internal/v1/bookings/${reference}/resume`,
    {
      method: "POST",
      headers: version ? { "X-Noir-Api-Version": version } : undefined,
      body: JSON.stringify(body),
    },
  );
}

describe("internal booking resume route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticateInternalRequest.mockImplementation(async (input: Request) => ({
      rawBody: await input.text(),
    }));
    resume.mockResolvedValue({
      kind: "resumable",
      bookingReference: reference,
      orderId: "order_resume",
      razorpayKeyId: "rzp_test_resume",
      holdExpiresAt: "2026-08-01T10:10:00.000Z",
    });
    getPublicBookingStatus.mockResolvedValue({
      status: "payment_pending",
      refundStatus: "not_required",
      bookingReference: reference,
      propertyName: "Emerald Suite",
      checkin: "2026-08-01",
      checkout: "2026-08-02",
      guestCount: 2,
      amountPaise: 10_000,
      currency: "INR",
    });
  });

  it("authenticates, validates, and resumes only the referenced booking", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(), {
      params: Promise.resolve({ reference }),
    });

    expect(response.status).toBe(200);
    expect(resume).toHaveBeenCalledWith(reference, resumeToken);
    expect(scheduleBookingJobs).toHaveBeenCalledOnce();
  });

  it("rejects malformed tokens before calling the recovery service", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ resumeToken: "short" }), {
      params: Promise.resolve({ reference }),
    });

    expect(response.status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });

  it("returns the authoritative premium status when the attempt cannot reopen Checkout", async () => {
    resume.mockResolvedValueOnce({
      status: "payment_pending",
      refundStatus: "not_required",
    });
    const { POST } = await import("./route");
    const response = await POST(request({ resumeToken }, "2"), {
      params: Promise.resolve({ reference }),
    });

    await expect(response.json()).resolves.toEqual({
      status: "payment_pending",
      refundStatus: "not_required",
      bookingReference: reference,
      propertyName: "Emerald Suite",
      checkin: "2026-08-01",
      checkout: "2026-08-02",
      guestCount: 2,
      amountPaise: 10_000,
      currency: "INR",
    });
    expect(getPublicBookingStatus).toHaveBeenCalledWith(reference);
  });

  it("does not reveal whether a token was invalid or revoked", async () => {
    resume.mockRejectedValueOnce(
      new BookingResumeServiceError("BOOKING_RESUME_TOKEN_REVOKED", 409),
    );
    const { POST } = await import("./route");
    const response = await POST(request(), {
      params: Promise.resolve({ reference }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "booking_recovery_unavailable",
    });
  });
});
