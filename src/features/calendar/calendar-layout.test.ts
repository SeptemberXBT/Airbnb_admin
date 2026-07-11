import { describe, expect, it } from "vitest";
import { assignEventLanes, eventSpan } from "./calendar-layout";

describe("calendar event layout", () => {
  it("clips bars to occupied nights and treats checkout as non-inclusive", () => {
    expect(eventSpan("2026-07-10", "2026-07-13", "2026-07-11", 14)).toEqual({ column: 1, span: 2 });
    expect(eventSpan("2026-07-12", "2026-07-15", "2026-07-11", 14)).toEqual({ column: 2, span: 3 });
    expect(eventSpan("2026-06-01", "2026-06-03", "2026-07-11", 14)).toBeNull();
  });

  it("places overlapping entries into deterministic lanes", () => {
    const entries = [
      { id: "a", startDate: "2026-07-11", endDate: "2026-07-14" },
      { id: "b", startDate: "2026-07-12", endDate: "2026-07-13" },
      { id: "c", startDate: "2026-07-14", endDate: "2026-07-15" },
    ];
    expect(assignEventLanes(entries).map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: "a", lane: 0 },
      { id: "b", lane: 1 },
      { id: "c", lane: 0 },
    ]);
  });
});
