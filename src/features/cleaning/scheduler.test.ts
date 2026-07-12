import { describe, expect, it } from "vitest";
import { buildCleaningSchedule, type CleaningCandidate } from "./scheduler";

const at = (time: string) => new Date(`2026-07-11T${time}:00+05:30`);
const candidate = (id: string, overrides: Partial<CleaningCandidate> = {}): CleaningCandidate => ({
  id,
  propertyId: id,
  propertyName: `Room ${id}`,
  releaseTime: at("11:05"),
  readyDeadline: at("11:55"),
  guestArrivalTime: at("12:00"),
  durationMinutes: 15,
  status: "queued",
  actualStart: null,
  actualEnd: null,
  delayMinutes: 0,
  ...overrides,
});

describe("single-team cleaning scheduler", () => {
  it("marks three noon-arrival rooms safe and later rooms impossible", () => {
    const schedule = buildCleaningSchedule([1, 2, 3, 4, 5].map((id) => candidate(String(id))), at("11:05"));
    expect(schedule.map((task) => task.warningLevel)).toEqual(["safe", "safe", "safe", "impossible", "impossible"]);
    expect(schedule.map((task) => task.plannedEnd?.toISOString())).toEqual([
      at("11:20").toISOString(), at("11:35").toISOString(), at("11:50").toISOString(),
      at("12:05").toISOString(), at("12:20").toISOString(),
    ]);
  });

  it("orders available arrivals chronologically and keeps no-arrival rooms last", () => {
    const schedule = buildCleaningSchedule([
      candidate("no-arrival", { readyDeadline: at("11:30"), guestArrivalTime: null }),
      candidate("arrival-1400", { readyDeadline: at("12:00"), guestArrivalTime: at("14:00") }),
      candidate("arrival-1330", { readyDeadline: at("13:25"), guestArrivalTime: at("13:30") }),
      candidate("arrival-1300", { readyDeadline: at("13:30"), guestArrivalTime: at("13:00") }),
    ], at("11:05"));
    expect(schedule.map((task) => task.id)).toEqual([
      "arrival-1300", "arrival-1330", "arrival-1400", "no-arrival",
    ]);
  });

  it("cleans an available later arrival instead of waiting for an earlier late checkout", () => {
    const schedule = buildCleaningSchedule([
      candidate("arrival-1300", { releaseTime: at("12:00"), readyDeadline: at("12:55"), guestArrivalTime: at("13:00") }),
      candidate("arrival-1330", { releaseTime: at("11:00"), readyDeadline: at("13:25"), guestArrivalTime: at("13:30") }),
    ], at("11:05"));
    expect(schedule.map((task) => task.id)).toEqual(["arrival-1330", "arrival-1300"]);
    expect(schedule[0].plannedStart?.toISOString()).toBe(at("11:05").toISOString());
    expect(schedule[1].plannedStart?.toISOString()).toBe(at("12:00").toISOString());
  });

  it("fills a large idle gap with an available no-arrival room", () => {
    const schedule = buildCleaningSchedule([
      candidate("arrival", { releaseTime: at("11:25"), readyDeadline: at("12:55"), guestArrivalTime: at("13:00") }),
      candidate("no-arrival", { releaseTime: at("11:00"), readyDeadline: at("17:00"), guestArrivalTime: null, durationMinutes: 15 }),
    ], at("11:05"));
    expect(schedule.map((task) => task.id)).toEqual(["no-arrival", "arrival"]);
    expect(schedule[0].plannedEnd?.toISOString()).toBe(at("11:20").toISOString());
    expect(schedule[1].plannedStart?.toISOString()).toBe(at("11:25").toISOString());
  });

  it("waits instead of letting a no-arrival room delay the next arriving room", () => {
    const schedule = buildCleaningSchedule([
      candidate("arrival", { releaseTime: at("11:15"), readyDeadline: at("12:55"), guestArrivalTime: at("13:00") }),
      candidate("no-arrival", { releaseTime: at("11:00"), readyDeadline: at("17:00"), guestArrivalTime: null, durationMinutes: 15 }),
    ], at("11:05"));
    expect(schedule.map((task) => task.id)).toEqual(["arrival", "no-arrival"]);
    expect(schedule[0].plannedStart?.toISOString()).toBe(at("11:15").toISOString());
  });

  it("pins cleaning now and extends its prediction when duration changes", () => {
    const running = candidate("running", { status: "cleaning_now", actualStart: at("11:10"), durationMinutes: 30 });
    const next = candidate("next");
    const schedule = buildCleaningSchedule([next, running], at("11:20"));
    expect(schedule[0].id).toBe("running");
    expect(schedule[0].plannedEnd?.toISOString()).toBe(at("11:40").toISOString());
    expect(schedule[1].plannedStart?.toISOString()).toBe(at("11:40").toISOString());
  });

  it("supports different checkout times, delays, no incoming guest, and already-vacant rooms", () => {
    const schedule = buildCleaningSchedule([
      candidate("late-checkout", { releaseTime: at("12:05"), readyDeadline: at("12:25"), guestArrivalTime: at("12:30") }),
      candidate("delayed", { delayMinutes: 20 }),
      candidate("vacant", { releaseTime: at("08:00"), readyDeadline: at("11:55") }),
      candidate("no-arrival", { readyDeadline: at("17:00"), guestArrivalTime: null }),
    ], at("11:05"));
    expect(schedule.map((task) => task.id)).toEqual(["vacant", "delayed", "no-arrival", "late-checkout"]);
    expect(schedule.find((task) => task.id === "late-checkout")?.warningLevel).toBe("waiting");
    expect(schedule.find((task) => task.id === "no-arrival")?.warningLevel).toBe("safe");
  });

  it("uses actual completion and labels overdue rooms", () => {
    const schedule = buildCleaningSchedule([
      candidate("done", { status: "ready", actualStart: at("11:05"), actualEnd: at("11:12") }),
      candidate("overdue", { readyDeadline: at("11:15"), guestArrivalTime: at("11:30") }),
    ], at("11:20"));
    expect(schedule.find((task) => task.id === "done")?.plannedEnd?.toISOString()).toBe(at("11:12").toISOString());
    expect(schedule.find((task) => task.id === "overdue")?.warningLevel).toBe("overdue");
  });
});
