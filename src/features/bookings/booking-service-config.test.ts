import { afterEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn(() => {
  throw new Error("DATABASE_REACHED");
}));

vi.mock("@/lib/db/client", () => ({ getDb }));

import { quoteAvailability } from "./booking-service";

describe("booking service configuration", () => {
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;

  afterEach(() => {
    getDb.mockClear();
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  });

  it("does not require Razorpay credentials to quote availability", () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    expect(() => quoteAvailability({
      publicRoomSlug: "sage-sunlight-studio",
      checkin: "2026-08-03",
      checkout: "2026-08-05",
      guests: 2,
    })).toThrow("DATABASE_REACHED");
    expect(getDb).toHaveBeenCalledOnce();
  });
});
