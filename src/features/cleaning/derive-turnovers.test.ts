import { describe, expect, it } from "vitest";
import { deriveTurnovers, type TurnoverProperty } from "./derive-turnovers";

const base: TurnoverProperty = {
  id: "property-1", name: "Garden Room", defaultCheckinTime: "13:00", defaultCheckoutTime: "11:00",
  defaultCleaningMinutes: 15, checkoutBufferMinutes: 5,
  housekeepingCutoffTime: "17:00", reservations: [],
};

describe("turnover derivation", () => {
  it("applies defaults, buffers, and reservation overrides in India time", () => {
    const [task] = deriveTurnovers([{ ...base, reservations: [
      { key: "external:out", startDate: "2026-07-09", endDate: "2026-07-11", expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: 20 },
      { key: "local:in", startDate: "2026-07-11", endDate: "2026-07-13", expectedCheckinTime: "12:00", expectedCheckoutTime: null, cleaningDurationMinutes: null },
    ] }], "2026-07-11");
    expect(task.releaseTime.toISOString()).toBe("2026-07-11T05:35:00.000Z");
    expect(task.readyDeadline.toISOString()).toBe("2026-07-11T06:25:00.000Z");
    expect(task.guestArrivalTime?.toISOString()).toBe("2026-07-11T06:30:00.000Z");
    expect(task.durationMinutes).toBe(20);
  });

  it("uses housekeeping cutoff without an arrival and ignores check-in-only dates", () => {
    const tasks = deriveTurnovers([
      { ...base, id: "out", reservations: [{ key: "external:out", startDate: "2026-07-09", endDate: "2026-07-11", expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null }] },
      { ...base, id: "vacant", reservations: [{ key: "external:in", startDate: "2026-07-11", endDate: "2026-07-12", expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null }] },
    ], "2026-07-11");
    expect(tasks).toHaveLength(1);
    const [outgoingOnly] = tasks;
    expect(outgoingOnly.guestArrivalTime).toBeNull();
    expect(outgoingOnly.readyDeadline.toISOString()).toBe("2026-07-11T11:30:00.000Z");
  });

  it("derives only one task for linked listing reservations on one physical property", () => {
    const tasks = deriveTurnovers([{ ...base, reservations: [
      { key: "external:a", startDate: "2026-07-09", endDate: "2026-07-11", expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null },
      { key: "external:b", startDate: "2026-07-09", endDate: "2026-07-11", expectedCheckinTime: null, expectedCheckoutTime: null, cleaningDurationMinutes: null },
    ] }], "2026-07-11");
    expect(tasks).toHaveLength(1);
  });
});
