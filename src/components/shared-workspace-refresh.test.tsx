import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedWorkspaceRefresh } from "./shared-workspace-refresh";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

describe("SharedWorkspaceRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockReset();
    setVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("refreshes visible shared data every eight seconds and on focus", async () => {
    render(<SharedWorkspaceRefresh />);

    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event("focus")));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh while hidden and refreshes when visibility returns", async () => {
    setVisibility("hidden");
    render(<SharedWorkspaceRefresh />);

    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
