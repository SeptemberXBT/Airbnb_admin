import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayQueue } from "./today-queue";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(cleanup);

describe("TodayQueue live recalculation", () => {
  beforeEach(() => { vi.useFakeTimers(); refresh.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("refreshes the server schedule every 30 seconds while visible", async () => {
    render(<TodayQueue tasks={[]} demoMode />);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("TodayQueue caretaker export", () => {
  it("copies the visible work sequence with effective guest times", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<TodayQueue serviceDate="2026-07-12" dateLabel="Sunday, 12 July" clock="1:00 PM" demoMode tasks={[{
      id: "task-1", propertyId: "property-1", propertyName: "Suite A", serviceDate: "2026-07-12",
      outgoingEntryKey: "external:out", incomingEntryKey: "external:in", checkoutTime: "11:00", checkinTime: "13:00",
      releaseTime: "2026-07-12T05:35:00.000Z", readyDeadline: "2026-07-12T07:25:00.000Z",
      guestArrivalTime: "2026-07-12T07:30:00.000Z", plannedStart: "2026-07-12T05:35:00.000Z",
      plannedEnd: "2026-07-12T06:05:00.000Z", durationMinutes: 30, status: "queued", warningLevel: "safe",
      actualStart: null, actualEnd: null, delayMinutes: 0,
    }]} />);

    expect(screen.getByText("11:00 AM")).toBeInTheDocument();
    expect(screen.getByText("1:00 PM")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy caretaker plan" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Suite A - checkout 11:00 AM"));
  });
});
