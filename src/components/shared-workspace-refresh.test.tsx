import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedWorkspaceRefresh } from "./shared-workspace-refresh";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const response = (version: string) => new Response(JSON.stringify({ version }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

describe("SharedWorkspaceRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    refresh.mockReset();
    setVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sets a baseline and refreshes only after the workspace version changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("v1"))
      .mockResolvedValueOnce(response("v1"))
      .mockResolvedValueOnce(response("v2"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedWorkspaceRefresh />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits while hidden and checks immediately when visibility returns", async () => {
    setVisibility("hidden");
    const fetchMock = vi.fn().mockResolvedValue(response("v1"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedWorkspaceRefresh />);

    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(fetchMock).not.toHaveBeenCalled();
    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not start another request while a version check is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<SharedWorkspaceRefresh />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(24_000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
