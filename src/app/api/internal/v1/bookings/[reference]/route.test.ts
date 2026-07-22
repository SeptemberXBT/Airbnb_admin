import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const getPublicBookingStatus = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/internal-api/request-auth")>()),
  authenticateInternalRequest,
}));
vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  getPublicBookingStatus,
}));

const reference = "NH-ROLLOUT123456";
const status = {
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

describe("booking status API rollout compatibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PUBLIC_BOOKING_ENABLED", "true");
    authenticateInternalRequest.mockResolvedValue({ keyId: "public", rawBody: "" });
    getPublicBookingStatus.mockResolvedValue(status);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps the legacy response shape for the currently deployed public client", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`https://admin.test/api/internal/v1/bookings/${reference}`), {
      params: Promise.resolve({ reference }),
    });
    await expect(response.json()).resolves.toEqual({ status: "confirmed", refundStatus: "not_required" });
  });

  it("returns the premium safe summary to API version 2", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`https://admin.test/api/internal/v1/bookings/${reference}`, {
      headers: { "X-Noir-Api-Version": "2" },
    }), { params: Promise.resolve({ reference }) });
    await expect(response.json()).resolves.toEqual(status);
  });
});
