import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const quoteAvailability = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/internal-api/request-auth")>()),
  authenticateInternalRequest,
}));

vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  quoteAvailability,
}));

const availabilityInput = {
  publicRoomSlug: "emerald-suite",
  checkin: "2026-08-05",
  checkout: "2026-08-06",
  guests: 1,
};

const quote = {
  available: true,
  ...availabilityInput,
  currency: "INR",
  nights: [{ date: "2026-08-05", amountPaise: 10_000, source: "weekday" }],
  totalPaise: 10_000,
};

function availabilityRequest() {
  return new Request("https://admin.test/api/internal/v1/availability", {
    method: "POST",
    body: JSON.stringify(availabilityInput),
  });
}

describe("internal availability rollout gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "false");
    vi.stubEnv("PUBLIC_BOOKING_ENABLED", "false");
    authenticateInternalRequest.mockResolvedValue({
      keyId: "booking-api-test",
      rawBody: JSON.stringify(availabilityInput),
    });
    quoteAvailability.mockResolvedValue(quote);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects availability when both rollout flags are disabled", async () => {
    const { POST } = await import("./route");
    const response = await POST(availabilityRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "booking_disabled" });
    expect(authenticateInternalRequest).not.toHaveBeenCalled();
    expect(quoteAvailability).not.toHaveBeenCalled();
  });

  it("quotes availability when only the availability flag is enabled", async () => {
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "true");
    const { POST } = await import("./route");
    const response = await POST(availabilityRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(quote);
    expect(quoteAvailability).toHaveBeenCalledWith(availabilityInput);
  });

  it("keeps availability enabled when full public booking is enabled", async () => {
    vi.stubEnv("PUBLIC_BOOKING_ENABLED", "true");
    const { POST } = await import("./route");
    const response = await POST(availabilityRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(quote);
    expect(quoteAvailability).toHaveBeenCalledWith(availabilityInput);
  });

  it("keeps booking creation disabled when only availability is enabled", async () => {
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "true");
    const { POST } = await import("../bookings/route");
    const response = await POST(new Request("https://admin.test/api/internal/v1/bookings", {
      method: "POST",
      body: "{}",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "booking_disabled" });
    expect(authenticateInternalRequest).not.toHaveBeenCalled();
  });
});
