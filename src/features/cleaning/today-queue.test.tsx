import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CleaningTaskView } from "./cleaning-service";
import { TodayQueue } from "./today-queue";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const task = (overrides: Partial<CleaningTaskView> = {}): CleaningTaskView => ({
  id: "task-1", propertyId: "property-1", propertyName: "Suite A", serviceDate: "2026-07-12",
  outgoingEntryKey: "external:out", incomingEntryKey: "external:in", checkoutTime: "11:00", checkinTime: "13:00",
  releaseTime: "2026-07-12T05:35:00.000Z", readyDeadline: "2026-07-12T07:25:00.000Z",
  guestArrivalTime: "2026-07-12T07:30:00.000Z", plannedStart: "2026-07-12T05:35:00.000Z",
  plannedEnd: "2026-07-12T06:05:00.000Z", durationMinutes: 30, status: "queued", warningLevel: "safe",
  actualStart: null, actualEnd: null, delayMinutes: 0,
  ...overrides,
});

describe("TodayQueue live actions", () => {
  beforeEach(() => refresh.mockClear());

  it("moves a ready task immediately into expandable completed work with its completion time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    render(<TodayQueue serviceDate="2026-07-12" demoMode={false} tasks={[task({ status: "cleaning_now", actualStart: "2026-07-12T05:40:00.000Z" })]} />);

    await userEvent.click(screen.getByRole("button", { name: "Ready" }));
    const completedToggle = await screen.findByRole("button", { name: /show completed and skipped/i });
    expect(completedToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Completed at/i)).not.toBeInTheDocument();

    await userEvent.click(completedToggle);
    expect(screen.getByRole("button", { name: /hide completed and skipped/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Completed at/i)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the current task visible when a ready request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "operation_failed" }), { status: 500 })));
    render(<TodayQueue serviceDate="2026-07-12" demoMode={false} tasks={[task({ status: "cleaning_now", actualStart: "2026-07-12T05:40:00.000Z" })]} />);

    await userEvent.click(screen.getByRole("button", { name: "Ready" }));
    await waitFor(() => expect(screen.getByText("Could not update the queue.")).toBeVisible());
    expect(screen.getByRole("button", { name: "Ready" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /show completed and skipped/i })).not.toBeInTheDocument();
  });

  it("keeps a missing arrival time empty after editing another field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    render(<TodayQueue serviceDate="2026-07-12" demoMode={false} tasks={[task({ incomingEntryKey: null, checkinTime: null })]} />);

    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByText("No arrival")).toBeVisible());
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });

  it.each(["ready", "skipped"] as const)("returns a %s task to Up next immediately", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TodayQueue serviceDate="2026-07-12" demoMode={false} tasks={[task({
      status,
      actualStart: status === "ready" ? "2026-07-12T05:40:00.000Z" : null,
      actualEnd: status === "ready" ? "2026-07-12T05:55:00.000Z" : null,
    })]} />);

    await userEvent.click(screen.getByRole("button", { name: /show completed and skipped/i }));
    await userEvent.click(screen.getByRole("button", { name: "Return Suite A to queue" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeVisible());
    expect(screen.queryByRole("button", { name: /show completed and skipped/i })).not.toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ taskId: "task-1", action: "requeue" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed task completed when requeue fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "operation_failed" }), { status: 500 })));
    render(<TodayQueue serviceDate="2026-07-12" demoMode={false} tasks={[task({ status: "skipped" })]} />);

    await userEvent.click(screen.getByRole("button", { name: /show completed and skipped/i }));
    await userEvent.click(screen.getByRole("button", { name: "Return Suite A to queue" }));

    await waitFor(() => expect(screen.getByText("Could not update the queue.")).toBeVisible());
    expect(screen.getByRole("button", { name: "Return Suite A to queue" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });
});

describe("TodayQueue caretaker export", () => {
  it("copies the visible work sequence with effective guest times", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<TodayQueue serviceDate="2026-07-12" dateLabel="Sunday, 12 July" clock="1:00 PM" demoMode tasks={[task()]} />);

    expect(screen.getByText("11:00 AM")).toBeInTheDocument();
    expect(screen.getByText("1:00 PM")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy caretaker plan" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Suite A - checkout 11:00 AM"));
  });
});
