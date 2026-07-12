import { describe, expect, it } from "vitest";
import { cleaningUpdateSchema } from "./cleaning-update-schema";

describe("cleaning update schema", () => {
  it("accepts requeue and rejects unknown actions", () => {
    const taskId = "10000000-0000-4000-8000-000000000001";

    expect(cleaningUpdateSchema.parse({ taskId, action: "requeue" }).action).toBe("requeue");
    expect(() => cleaningUpdateSchema.parse({ taskId, action: "undo" })).toThrow();
  });
});
