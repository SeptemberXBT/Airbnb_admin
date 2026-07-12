import { describe, expect, it } from "vitest";
import { sharedWorkspaceVersion } from "./shared-workspace-version";

describe("sharedWorkspaceVersion", () => {
  it("changes when any shared field changes", () => {
    const original = [{ id: "property-1", cleaningMinutes: 15, checkinTime: "13:00" }];
    const changed = [{ id: "property-1", cleaningMinutes: 20, checkinTime: "13:00" }];

    expect(sharedWorkspaceVersion(changed)).not.toBe(sharedWorkspaceVersion(original));
  });
});
