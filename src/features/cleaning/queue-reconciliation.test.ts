import { describe, expect, it, vi } from "vitest";
import type { DerivedTurnover } from "./derive-turnovers";
import { reconcileCleaningTasks } from "./queue-reconciliation";

describe("reconcileCleaningTasks", () => {
  it("uses a fixed store call count as turnover count grows", async () => {
    const store = { archiveStale: vi.fn(), upsertDerived: vi.fn() };
    const tasks: DerivedTurnover[] = Array.from({ length: 20 }, (_, index) => ({
      key: `property-${index}:2026-07-13`,
      propertyId: `property-${index}`,
      propertyName: `Property ${index}`,
      outgoingEntryKey: `external:${index}`,
      incomingEntryKey: null,
      releaseTime: new Date("2026-07-13T05:35:00.000Z"),
      readyDeadline: new Date("2026-07-13T11:30:00.000Z"),
      guestArrivalTime: null,
      durationMinutes: 15,
    }));

    await reconcileCleaningTasks(store, tasks.map((task) => task.propertyId), "2026-07-13", tasks);

    expect(store.archiveStale).toHaveBeenCalledTimes(1);
    expect(store.upsertDerived).toHaveBeenCalledTimes(1);
    expect(store.upsertDerived).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ propertyId: "property-0", releaseTime: "2026-07-13T05:35:00.000Z" }),
    ]));
  });
});
