import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEntry, CalendarProperty } from "./calendar-types";
import { CalendarWorkspace } from "./calendar-workspace";

const property: CalendarProperty = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Suite A",
  defaultCheckinTime: "13:00",
  defaultCheckoutTime: "11:00",
  defaultCleaningMinutes: 15,
  lastSyncAt: "2026-07-12T08:00:00.000Z",
  lastSyncStatus: "success",
  isStale: false,
  entries: [],
};

function calendarEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "entry-1",
    propertyId: property.id,
    listingId: null,
    source: "local",
    kind: "direct_reservation",
    label: "Mayank",
    startDate: "2020-01-01",
    endDate: "2099-01-01",
    privateBookingName: "Mayank",
    paymentAmount: "2500.00",
    privateContact: null,
    privateNote: null,
    expectedCheckinTime: null,
    expectedCheckoutTime: null,
    cleaningDurationMinutes: null,
    reservationUrl: null,
    syncToAirbnb: true,
    airbnbObserved: true,
    completedEarlyAt: null,
    earlyCheckoutEffectiveDate: null,
    releaseObservedOnAirbnb: false,
    sameDayTurnover: false,
    publicReference: null,
    holdExpiresAt: null,
    ...overrides,
  };
}

describe("CalendarWorkspace mutation feedback", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    HTMLDialogElement.prototype.close = function close() { this.open = false; this.dispatchEvent(new Event("close")); };
    HTMLElement.prototype.scrollBy = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("collapses rapid calendar scrolling into one browser URL update", () => {
    vi.useFakeTimers();
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 58, height: 58, top: 0, right: 58, bottom: 58, left: 0, x: 0, y: 0,
      toJSON: () => ({}),
    });
    render(<CalendarWorkspace properties={[property]} startDate="2026-07-05" anchorDate="2026-07-12" zoom={14} demoMode={false} />);
    const calendar = screen.getByLabelText("Infinite property calendar");
    Object.defineProperties(calendar, {
      clientWidth: { configurable: true, value: 390 },
      scrollWidth: { configurable: true, value: 2200 },
    });

    for (let offset = 580; offset < 640; offset += 3) {
      Object.defineProperty(calendar, "scrollLeft", { configurable: true, value: offset, writable: true });
      fireEvent.scroll(calendar);
    }

    expect(replaceState).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("disables repeated save and closes the editor after the focused calendar reload", async () => {
    let finishSave: (response: Response) => void = () => undefined;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingSave)
      .mockResolvedValueOnce(new Response(JSON.stringify({ startDate: "2026-07-05", days: 28, properties: [property] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CalendarWorkspace properties={[property]} startDate="2026-07-05" anchorDate="2026-07-12" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Add entry for Suite A on 12 July 2026" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Guest name"), "Riya");
    await userEvent.type(within(dialog).getByLabelText("Total payment (INR)"), "12500.50");
    const save = within(dialog).getByRole("button", { name: "Save" });
    const click = userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await userEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishSave(new Response(JSON.stringify({ id: "entry-1" }), { status: 201 }));
    await click;
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const submitted = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(submitted).toMatchObject({ privateBookingName: "Riya", paymentAmount: 12500.50 });
  });

  it("preserves the 409 overlap confirmation flow for inventory conflicts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "overlap" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "entry-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startDate: "2026-07-05", days: 28, properties: [property] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CalendarWorkspace properties={[property]} startDate="2026-07-05" anchorDate="2026-07-12" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Add entry for Suite A on 12 July 2026" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Confirm the overlap to continue");
    await userEvent.click(within(dialog).getByLabelText("Confirm overlapping entry"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ allowOverlap: true });
  });

  it("downloads a manual booking CSV for the selected range", async () => {
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Date,Suite A\r\n2026-07-12,INR 500.00\r\n", { status: 200 })));
    render(<CalendarWorkspace properties={[property]} startDate="2026-07-05" anchorDate="2026-07-12" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Start date")).toHaveValue("2026-07-12");
    expect(within(dialog).getByLabelText("End date")).toHaveValue("2026-07-25");
    await userEvent.click(within(dialog).getByRole("button", { name: "Download CSV" }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
  });

  it("renders website payment holds, confirmed references, and operational alerts without guest PII", () => {
    const operationalProperty = {
      ...property,
      alerts: [{ id: "alert-1", severity: "error", message: "Refund failed for NH-FAILED123456" }],
      entries: [
        {
          id: "hold-1", propertyId: property.id, listingId: null, source: "website", kind: "payment_hold",
          label: "Payment in progress", startDate: "2026-07-12", endDate: "2026-07-14",
          privateBookingName: null, paymentAmount: null, privateContact: null, privateNote: null,
          expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null,
          reservationUrl: null, syncToAirbnb: false, airbnbObserved: false,
          publicReference: "NH-HOLD12345678", holdExpiresAt: "2026-07-12T10:10:00.000Z",
        },
        {
          id: "direct-1", propertyId: property.id, listingId: null, source: "website", kind: "direct_reservation",
          label: "Website booking · NH-BOOKED123456", startDate: "2026-07-15", endDate: "2026-07-17",
          privateBookingName: null, paymentAmount: null, privateContact: null, privateNote: null,
          expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null,
          reservationUrl: null, syncToAirbnb: true, airbnbObserved: false,
          publicReference: "NH-BOOKED123456", holdExpiresAt: null,
        },
      ],
    } as CalendarProperty;

    render(<CalendarWorkspace properties={[operationalProperty]} startDate="2026-07-05" anchorDate="2026-07-12" zoom={14} demoMode={false} />);

    const hold = screen.getByRole("button", { name: /Payment in progress.*2026-07-12 to 2026-07-14/i });
    expect(hold).toHaveClass("calendar-event--hold");
    expect(hold).toHaveAttribute("title", expect.stringMatching(/expires/i));
    expect(screen.getByRole("button", { name: /Website booking.*NH-BOOKED123456/i })).toHaveClass("calendar-event--direct");
    expect(screen.getByRole("alert")).toHaveTextContent("Refund failed for NH-FAILED123456");
    expect(document.body).not.toHaveTextContent("riya@example.test");
  });

  it("releases an eligible direct reservation with one click and refreshes it as read-only history", async () => {
    const activeEntry = calendarEntry();
    const completedEntry = calendarEntry({
      kind: "completed_early",
      label: "Completed early",
      completedEarlyAt: "2026-08-07T12:00:00.000Z",
      earlyCheckoutEffectiveDate: "2026-08-07",
      airbnbObserved: false,
    });
    const activeProperty = { ...property, entries: [activeEntry] };
    const completedProperty = { ...property, entries: [completedEntry] };
    let finishRelease: (response: Response) => void = () => undefined;
    const pendingRelease = new Promise<Response>((resolve) => { finishRelease = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingRelease)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        startDate: "2026-07-31",
        days: 28,
        properties: [completedProperty],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CalendarWorkspace properties={[activeProperty]} startDate="2026-07-31" anchorDate="2026-08-07" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: /Mayank, 2020-01-01 to 2099-01-01/i }));
    const dialog = screen.getByRole("dialog");
    const release = within(dialog).getByRole("button", { name: "Check out early — release room now" });
    const releaseClick = userEvent.click(release);

    await waitFor(() => expect(release).toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/local-entries/entry-1/early-checkout", { method: "POST" });
    expect(confirm).not.toHaveBeenCalled();

    finishRelease(new Response(JSON.stringify({
      ok: true,
      entryId: activeEntry.id,
      completedEarlyAt: "2026-08-07T12:00:00.000Z",
      earlyCheckoutEffectiveDate: "2026-08-07",
      idempotent: false,
    }), { status: 200 }));
    await releaseClick;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText("Completed early")).toBeInTheDocument();
    expect(within(dialog).getByText("Released internally — awaiting Airbnb refresh")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it.each([
    ["future direct", calendarEntry({ startDate: "2026-08-20", endDate: "2026-08-21" })],
    ["blocked", calendarEntry({ kind: "blocked", label: "Blocked" })],
    ["Airbnb", calendarEntry({ source: "airbnb", kind: "reservation", label: "Airbnb reservation" })],
    ["completed", calendarEntry({
      kind: "completed_early",
      label: "Completed early",
      completedEarlyAt: "2026-08-07T12:00:00.000Z",
      earlyCheckoutEffectiveDate: "2026-08-07",
    })],
  ])("does not offer early checkout for a %s entry", async (_label, entry) => {
    const entryProperty = { ...property, entries: [entry] };
    render(<CalendarWorkspace properties={[entryProperty]} startDate="2026-07-31" anchorDate="2026-08-07" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${entry.label},`) }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Check out early — release room now" })).not.toBeInTheDocument();
  });

  it("shows when Airbnb has observed the released inventory", async () => {
    const completedProperty = { ...property, entries: [calendarEntry({
      kind: "completed_early",
      label: "Completed early",
      completedEarlyAt: "2026-08-07T12:00:00.000Z",
      earlyCheckoutEffectiveDate: "2026-08-07",
      releaseObservedOnAirbnb: true,
    })] };
    render(<CalendarWorkspace properties={[completedProperty]} startDate="2026-07-31" anchorDate="2026-08-07" zoom={14} demoMode={false} />);

    await userEvent.click(screen.getByRole("button", { name: /Completed early,/i }));
    expect(within(screen.getByRole("dialog")).getByText("Release observed on Airbnb")).toBeInTheDocument();
  });
});
