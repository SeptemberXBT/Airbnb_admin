import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Postgres cleaning reconciliation", () => {
  it("does not update unchanged or currently running tasks", async () => {
    const source = await readFile(path.join(process.cwd(), "src/features/cleaning/queue-reconciliation-store.ts"), "utf8");
    expect(source).toMatch(/do update set[\s\S]*where public\.cleaning_tasks\.status <> 'cleaning_now'/i);
    expect(source).toMatch(/is distinct from excluded\.release_time/i);
    expect(source).toMatch(/is distinct from excluded\.expected_duration_minutes/i);
  });
});
