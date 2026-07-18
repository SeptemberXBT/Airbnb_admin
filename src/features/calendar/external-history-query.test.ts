import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (file: string) => readFile(path.join(process.cwd(), file), "utf8");

describe("retained Airbnb event queries", () => {
  it("includes retained history in calendar, cleaning, and overlap reads", async () => {
    const [calendar, cleaning, entry] = await Promise.all([
      readSource("src/features/calendar/calendar-service.ts"),
      readSource("src/features/cleaning/cleaning-service.ts"),
      readSource("src/features/calendar/entry-service.ts"),
    ]);

    expect(calendar).toMatch(/and \(e\.active or e\.historical\) and e\.start_date/);
    expect(cleaning).toMatch(/and \(e\.active or e\.historical\) and e\.event_type/);
    expect(entry).toMatch(/where l\.property_id = \$\{input\.propertyId\} and \(e\.active or e\.historical\)/);
    expect(calendar).not.toMatch(/where l\.property_id in[^\n]+and e\.active and e\.start_date/);
    expect(cleaning).not.toMatch(/where l\.property_id in[^\n]+and e\.active and e\.event_type/);
  });
});
