import { describe, expect, it } from "vitest";
import { planReconciliation } from "./reconcile";

describe("feed reconciliation", () => {
  it("is idempotent for unchanged active events", () => {
    const plan = planReconciliation(
      [{ id: "1", sourceUid: "uid-1", contentHash: "same", active: true }],
      [{ sourceUid: "uid-1", contentHash: "same", eventType: "reservation", startDate: "2026-07-11", endDate: "2026-07-12", sanitizedReservationUrl: null }],
    );
    expect(plan).toEqual({ create: [], update: [], archive: [] });
  });

  it("creates new, updates changed, reactivates returned, and archives missing records", () => {
    const plan = planReconciliation(
      [
        { id: "old", sourceUid: "gone", contentHash: "old", active: true },
        { id: "changed", sourceUid: "changed", contentHash: "before", active: true },
        { id: "returned", sourceUid: "returned", contentHash: "same", active: false },
      ],
      [
        { sourceUid: "new", contentHash: "new-hash", eventType: "unknown", startDate: "2026-07-11", endDate: "2026-07-12", sanitizedReservationUrl: null },
        { sourceUid: "changed", contentHash: "after", eventType: "reservation", startDate: "2026-07-12", endDate: "2026-07-14", sanitizedReservationUrl: null },
        { sourceUid: "returned", contentHash: "same", eventType: "unavailable", startDate: "2026-07-15", endDate: "2026-07-16", sanitizedReservationUrl: null },
      ],
    );
    expect(plan.create.map((event) => event.sourceUid)).toEqual(["new"]);
    expect(plan.update.map(({ existingId }) => existingId)).toEqual(["changed", "returned"]);
    expect(plan.archive).toEqual(["old"]);
  });
});
