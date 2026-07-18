import { describe, expect, it } from "vitest";
import { planReconciliation, type ExistingCalendarEvent } from "./reconcile";

const incoming = (sourceUid: string, contentHash = "same") => ({
  sourceUid,
  contentHash,
  eventType: "reservation" as const,
  startDate: "2026-07-18",
  endDate: "2026-07-19",
  sanitizedReservationUrl: null,
});

const existing = (overrides: Partial<ExistingCalendarEvent> & Pick<ExistingCalendarEvent, "id" | "sourceUid">): ExistingCalendarEvent => ({
  contentHash: "same",
  startDate: "2026-07-18",
  endDate: "2026-07-19",
  active: true,
  historical: false,
  ...overrides,
});

describe("feed reconciliation", () => {
  it("is idempotent for unchanged active events", () => {
    const plan = planReconciliation(
      [existing({ id: "1", sourceUid: "uid-1" })],
      [incoming("uid-1")],
      "2026-07-19",
    );
    expect(plan).toEqual({ create: [], update: [], archive: [], retainHistory: [] });
  });

  it("creates new, updates changed, and reactivates returned archived records", () => {
    const plan = planReconciliation(
      [
        existing({ id: "changed", sourceUid: "changed", contentHash: "before" }),
        existing({ id: "returned", sourceUid: "returned", active: false }),
      ],
      [incoming("new", "new-hash"), incoming("changed", "after"), incoming("returned")],
      "2026-07-19",
    );
    expect(plan.create.map((event) => event.sourceUid)).toEqual(["new"]);
    expect(plan.update.map(({ existingId }) => existingId)).toEqual(["changed", "returned"]);
    expect(plan.archive).toEqual([]);
    expect(plan.retainHistory).toEqual([]);
  });

  it("retains completed missing events and archives missing events whose checkout is ahead", () => {
    const plan = planReconciliation(
      [
        existing({ id: "completed", sourceUid: "completed", endDate: "2026-07-19" }),
        existing({ id: "ongoing", sourceUid: "ongoing", startDate: "2026-07-18", endDate: "2026-07-20" }),
        existing({ id: "future", sourceUid: "future", startDate: "2026-07-25", endDate: "2026-07-27" }),
      ],
      [],
      "2026-07-19",
    );
    expect(plan.retainHistory).toEqual(["completed"]);
    expect(plan.archive).toEqual(["ongoing", "future"]);
  });

  it("leaves previously historical and archived missing events untouched", () => {
    const plan = planReconciliation(
      [
        existing({ id: "historical", sourceUid: "historical", active: false, historical: true }),
        existing({ id: "cancelled", sourceUid: "cancelled", active: false }),
      ],
      [],
      "2026-07-19",
    );
    expect(plan.archive).toEqual([]);
    expect(plan.retainHistory).toEqual([]);
  });

  it("reactivates a historical event when it returns unchanged", () => {
    const plan = planReconciliation(
      [existing({ id: "historical", sourceUid: "historical", active: false, historical: true })],
      [incoming("historical")],
      "2026-07-19",
    );
    expect(plan.update.map(({ existingId }) => existingId)).toEqual(["historical"]);
  });
});
