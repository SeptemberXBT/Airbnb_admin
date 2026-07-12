import { describe, expect, it } from "vitest";
import { formatCaretakerPlan, type CaretakerExportTask } from "./caretaker-export";

const task = (overrides: Partial<CaretakerExportTask> = {}): CaretakerExportTask => ({
  propertyName: "Suite A",
  status: "queued",
  checkoutTime: "11:00",
  checkinTime: "13:00",
  plannedStart: "2026-07-12T05:35:00.000Z",
  plannedEnd: "2026-07-12T06:05:00.000Z",
  durationMinutes: 30,
  ...overrides,
});

describe("caretaker export", () => {
  it("formats only current work as short privacy-safe WhatsApp text", () => {
    const text = formatCaretakerPlan("2026-07-12", [
      task(),
      task({ propertyName: "Suite B", checkoutTime: "12:00", checkinTime: null,
        plannedStart: "2026-07-12T06:30:00.000Z", plannedEnd: "2026-07-12T06:50:00.000Z", durationMinutes: 20 }),
      task({ propertyName: "Suite C", status: "ready" }),
      task({ propertyName: "Suite D", status: "skipped" }),
    ]);

    expect(text).toBe([
      "Noir Haus cleaning - Sun, 12 Jul",
      "1. Suite A - checkout 11:00 AM | clean 11:05 AM-11:35 AM (30 min) | check-in 1:00 PM",
      "2. Suite B - checkout 12:00 PM | clean 12:00 PM-12:20 PM (20 min) | no arrival",
    ].join("\n"));
    expect(text).not.toContain("Suite C");
    expect(text).not.toContain("Suite D");
  });
});
