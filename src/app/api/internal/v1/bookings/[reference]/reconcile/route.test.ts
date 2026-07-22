import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const reconcileBooking = vi.hoisted(() => vi.fn());
const getPublicBookingStatus = vi.hoisted(() => vi.fn());
const scheduleBookingJobs = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/internal-api/request-auth")>()),
  authenticateInternalRequest,
}));
vi.mock("@/features/payments/payment-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/payments/payment-reconciliation")>()),
  reconcileBooking,
}));
vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  getPublicBookingStatus,
}));
vi.mock("@/features/bookings/schedule-jobs", () => ({ scheduleBookingJobs }));

const reference = "NH-ROLLOUT123456";
const premiumStatus = {
  status: "confirmed",
  refundStatus: "not_required",
  bookingReference: reference,
  propertyName: "Emerald Suite",
  checkin: "2026-08-05",
  checkout: "2026-08-06",
  guestCount: 2,
  amountPaise: 10_000,
  currency: "INR",
};

function request(version?: string) {
  return new Request(`https://admin.test/api/internal/v1/bookings/${reference}/reconcile`, {
    method: "POST",
    headers: version ? { "X-Noir-Api-Version": version } : undefined,
    body: JSON.stringify({ trigger: "client_callback" }),
  });
}

describe("booking reconciliation API rollout compatibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authenticateInternalRequest.mockResolvedValue({ rawBody: JSON.stringify({ trigger: "client_callback" }) });
    reconcileBooking.mockResolvedValue({ status: "confirmed", refundStatus: "not_required" });
    getPublicBookingStatus.mockResolvedValue(premiumStatus);
  });

  it("returns the legacy reconciliation shape without version 2", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(), { params: Promise.resolve({ reference }) });
    await expect(response.json()).resolves.toEqual({ status: "confirmed", refundStatus: "not_required" });
    expect(getPublicBookingStatus).not.toHaveBeenCalled();
  });

  it("returns the authoritative premium summary for version 2", async () => {
    const { POST } = await import("./route");
    const response = await POST(request("2"), { params: Promise.resolve({ reference }) });
    await expect(response.json()).resolves.toEqual(premiumStatus);
    expect(getPublicBookingStatus).toHaveBeenCalledWith(reference);
  });
});
