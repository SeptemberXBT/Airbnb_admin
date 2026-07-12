import { describe, expect, it } from "vitest";
import { workspaceVersion } from "./workspace-version";

describe("workspaceVersion", () => {
  it("changes when any accessible source timestamp changes", () => {
    const original = ["2026-07-13T00:00:00.000Z", null, "2026-07-13T00:01:00.000Z"];
    const changed = ["2026-07-13T00:00:00.000Z", null, "2026-07-13T00:02:00.000Z"];
    expect(workspaceVersion(changed)).not.toBe(workspaceVersion(original));
  });
});
