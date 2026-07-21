import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingSummary } from "./pricing-service";
import { PricingManager } from "./pricing-manager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const room: PricingSummary = {
  propertyId: "10000000-0000-4000-8000-000000000001",
  propertyName: "Shade of Love",
  active: true,
  publicRoomSlug: "shade-of-love",
  maxGuests: 2,
  weekdayPricePaise: 500000,
  weekendPricePaise: 650000,
  bookingEnabled: true,
  overrides: [{ stayDate: "2026-08-08", pricePaise: 700000 }],
};

describe("PricingManager", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    refresh.mockReset();
  });

  it("renders one horizontally scrollable property row with base rates and effective night cells", () => {
    render(<PricingManager initialPricing={[room]} demoMode={false} startDate="2026-08-07" />);

    const row = screen.getByRole("article", { name: "Pricing for Shade of Love" });
    expect(within(row).getByLabelText("Weekday price for Shade of Love (₹)")).toHaveValue(5000);
    expect(within(row).getByLabelText("Weekend price for Shade of Love (₹)")).toHaveValue(6500);
    expect(within(row).getByRole("button", { name: /edit price for Shade of Love on 2026-08-07/i })).toHaveTextContent("₹6,500");
    expect(within(row).getByRole("button", { name: /edit price for Shade of Love on 2026-08-08/i })).toHaveTextContent("₹7,000");
    expect(screen.getByTestId("pricing-scroller")).toHaveClass("pricing-scroller");
  });

  it("creates, edits, and clears custom date prices through authenticated API mutations", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    render(<PricingManager initialPricing={[room]} demoMode={false} startDate="2026-08-07" />);

    await user.click(screen.getByRole("button", { name: /edit price for Shade of Love on 2026-08-07/i }));
    await user.clear(screen.getByLabelText("Custom night price (₹)"));
    await user.type(screen.getByLabelText("Custom night price (₹)"), "7200");
    await user.click(screen.getByRole("button", { name: "Save custom price" }));

    await user.click(screen.getByRole("button", { name: /edit price for Shade of Love on 2026-08-08/i }));
    await user.clear(screen.getByLabelText("Custom night price (₹)"));
    await user.type(screen.getByLabelText("Custom night price (₹)"), "7300");
    await user.click(screen.getByRole("button", { name: "Save custom price" }));
    await user.click(screen.getByRole("button", { name: /edit price for Shade of Love on 2026-08-08/i }));
    await user.click(screen.getByRole("button", { name: "Clear custom price" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "save_override",
      propertyId: room.propertyId,
      stayDate: "2026-08-07",
      pricePaise: 720000,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      action: "save_override",
      stayDate: "2026-08-08",
      pricePaise: 730000,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      action: "clear_override",
      stayDate: "2026-08-08",
    });
  });

  it("guards a pending base-rate request from duplicate submission", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    render(<PricingManager initialPricing={[room]} demoMode={false} startDate="2026-08-07" />);

    const save = screen.getByRole("button", { name: "Save base rates for Shade of Love" });
    await user.click(save);
    await user.click(save);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
  });

  it("does not mutate pricing in demo mode", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<PricingManager initialPricing={[room]} demoMode startDate="2026-08-07" />);

    await user.click(screen.getByRole("button", { name: "Save base rates for Shade of Love" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Connect Supabase to save pricing changes.");
  });
});
