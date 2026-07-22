import { beforeEach, describe, expect, it, vi } from "vitest";

const listBookingsForUser = vi.fn();
vi.mock("@/features/bookings/admin-booking-service", () => ({ listBookingsForUser }));
vi.mock("@/lib/auth/require-user", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));

describe("admin bookings route", () => {
  beforeEach(() => listBookingsForUser.mockReset().mockResolvedValue([]));

  it("defaults to active bookings and accepts archived/all visibility filters", async () => {
    const { GET } = await import("./route");
    expect((await GET(new Request("https://admin.test/api/bookings"))).status).toBe(200);
    expect((await GET(new Request("https://admin.test/api/bookings?view=archived&search=NH"))).status).toBe(200);
    expect((await GET(new Request("https://admin.test/api/bookings?view=all"))).status).toBe(200);
    expect(listBookingsForUser).toHaveBeenNthCalledWith(1, "user-1", undefined, "active");
    expect(listBookingsForUser).toHaveBeenNthCalledWith(2, "user-1", "NH", "archived");
    expect(listBookingsForUser).toHaveBeenNthCalledWith(3, "user-1", undefined, "all");
  });

  it("rejects unknown visibility filters", async () => {
    const { GET } = await import("./route");
    expect((await GET(new Request("https://admin.test/api/bookings?view=deleted"))).status).toBe(400);
  });
});
