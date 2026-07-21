import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/calendar",
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("AppShell", () => {
  it("provides all six management destinations without hover-only controls", async () => {
    let AppShell: React.ComponentType<React.PropsWithChildren> | undefined;
    try {
      AppShell = (await import("./app-shell")).AppShell;
    } catch {
      AppShell = undefined;
    }

    expect(AppShell).toBeDefined();
    if (!AppShell) return;

    render(<AppShell><p>Workspace</p></AppShell>);
    expect(screen.getByText("Noir Haus")).toBeVisible();
    expect(screen.getAllByRole("link", { name: /calendar/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /today/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /properties/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /pricing/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /bookings/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /settings/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Workspace")).toBeVisible();
  });
});
