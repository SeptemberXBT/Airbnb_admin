import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayQueue } from "./today-queue";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("TodayQueue live recalculation", () => {
  beforeEach(() => { vi.useFakeTimers(); refresh.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("refreshes the server schedule every 30 seconds while visible", async () => {
    render(<TodayQueue tasks={[]} demoMode />);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
