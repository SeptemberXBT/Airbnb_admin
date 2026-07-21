import { afterEach, describe, expect, it, vi } from "vitest";

const { getDb } = vi.hoisted(() => ({
  getDb: vi.fn(() => {
    throw new Error("demo mode must not open the database");
  }),
}));

vi.mock("@/lib/db/client", () => ({ getDb }));

import { listPricingForUser } from "./pricing-service";

describe("pricing service demo mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getDb.mockClear();
  });

  it("returns synthetic room pricing without opening the database", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "development");

    const pricing = await listPricingForUser("demo-user");

    expect(getDb).not.toHaveBeenCalled();
    expect(pricing).toHaveLength(8);
    expect(pricing.map((room) => room.publicRoomSlug)).toContain("shade-of-love");
    expect(pricing.every((room) => room.weekdayPricePaise && room.weekendPricePaise)).toBe(true);
  });
});
