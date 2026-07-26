import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalRequestAuthError } from "@/features/internal-api/request-auth";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const quoteAvailabilityBatch = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/internal-api/request-auth")>()),
  authenticateInternalRequest,
}));

vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  quoteAvailabilityBatch,
}));

const input = {
  checkin: "2026-08-14",
  checkout: "2026-08-17",
  guests: 2,
};
const result = {
  ...input,
  currency: "INR",
  rooms: [],
};

function request(body: unknown = input) {
  return new Request("https://admin.test/api/internal/v1/availability/batch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("signed batch availability route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "false");
    vi.stubEnv("PUBLIC_BOOKING_ENABLED", "false");
    authenticateInternalRequest.mockResolvedValue({
      keyId: "booking-api-test",
      rawBody: JSON.stringify(input),
    });
    quoteAvailabilityBatch.mockResolvedValue(result);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("fails before authentication when both rollout flags are disabled", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(authenticateInternalRequest).not.toHaveBeenCalled();
  });

  it.each(["PUBLIC_AVAILABILITY_ENABLED", "PUBLIC_BOOKING_ENABLED"])(
    "quotes when %s is enabled",
    async (flag) => {
      vi.stubEnv(flag, "true");
      const { POST } = await import("./route");
      const signedRequest = request({ untrusted: true });
      const response = await POST(signedRequest);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(authenticateInternalRequest).toHaveBeenCalledWith(signedRequest);
      expect(quoteAvailabilityBatch).toHaveBeenCalledWith(input);
      await expect(response.json()).resolves.toEqual(result);
    },
  );

  it("authenticates the raw body before parsing or trusting JSON", async () => {
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "true");
    authenticateInternalRequest.mockResolvedValue({
      keyId: "booking-api-test",
      rawBody: "{not-json",
    });
    const { POST } = await import("./route");
    const response = await POST(request(input));

    expect(response.status).toBe(400);
    expect(authenticateInternalRequest).toHaveBeenCalledOnce();
    expect(quoteAvailabilityBatch).not.toHaveBeenCalled();
  });

  it("maps authentication, validation, and service failures safely", async () => {
    vi.stubEnv("PUBLIC_AVAILABILITY_ENABLED", "true");
    const { POST } = await import("./route");

    authenticateInternalRequest.mockRejectedValueOnce(
      new InternalRequestAuthError("NONCE_REPLAY"),
    );
    expect((await POST(request())).status).toBe(401);

    authenticateInternalRequest.mockResolvedValueOnce({
      keyId: "booking-api-test",
      rawBody: JSON.stringify({ ...input, amountPaise: 1 }),
    });
    expect((await POST(request())).status).toBe(400);

    quoteAvailabilityBatch.mockRejectedValueOnce(new Error("database down"));
    expect((await POST(request())).status).toBe(503);
  });
});
