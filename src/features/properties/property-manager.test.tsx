import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyManager } from "./property-manager";
import type { PropertySummary } from "./property-service";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const property: PropertySummary = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Garden Suite",
  active: true,
  defaultCheckinTime: "13:00",
  defaultCheckoutTime: "11:00",
  defaultCleaningMinutes: 15,
  listingId: "20000000-0000-4000-8000-000000000002",
  listingName: "Garden Suite on Airbnb",
  listingActive: true,
  outboundEnabled: false,
  lastSyncAt: null,
  lastSyncStatus: null,
};

function fillPropertyForm(container: HTMLElement) {
  const values: Record<string, string> = {
    name: "Garden Suite",
    displayName: "Garden Suite on Airbnb",
    inboundIcalUrl: "https://www.airbnb.com/calendar/ical/123.ics?s=secret",
  };
  for (const [name, value] of Object.entries(values)) {
    const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!input) throw new Error(`Missing ${name}`);
    input.value = value;
  }
}

describe("PropertyManager mutation feedback", () => {
  beforeEach(() => refresh.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("disables duplicate submission, reloads the list, and closes the successful add form", async () => {
    let finishPost: (response: Response) => void = () => undefined;
    const pendingPost = new Promise<Response>((resolve) => { finishPost = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingPost)
      .mockResolvedValueOnce(new Response(JSON.stringify({ properties: [property] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PropertyManager initialProperties={[]} demoMode={false} />);

    await userEvent.click(screen.getByText("Add property"));
    const details = screen.getByText("Add property").closest("details");
    if (!details) throw new Error("Missing add property disclosure");
    expect(details.querySelector('[name="checkinBufferMinutes"]')).not.toBeInTheDocument();
    fillPropertyForm(details);
    const save = screen.getByRole("button", { name: "Save property" });
    const click = userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await userEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishPost(new Response(JSON.stringify({ propertyId: property.id, listingId: property.listingId }), { status: 201 }));
    await click;
    await waitFor(() => expect(details).not.toHaveAttribute("open"));
    expect(screen.getByText("Garden Suite")).toBeVisible();
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ checkinBufferMinutes: 5 });
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the add form and its values open when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "operation_failed" }), { status: 500 })));
    render(<PropertyManager initialProperties={[]} demoMode={false} />);

    await userEvent.click(screen.getByText("Add property"));
    const details = screen.getByText("Add property").closest("details");
    if (!details) throw new Error("Missing add property disclosure");
    fillPropertyForm(details);
    await userEvent.click(screen.getByRole("button", { name: "Save property" }));

    await waitFor(() => expect(screen.getByText("Could not save this property. Check every field.")).toBeVisible());
    expect(details).toHaveAttribute("open");
    expect(details.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe("Garden Suite");
  });
});
