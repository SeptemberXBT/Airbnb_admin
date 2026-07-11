import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("security hardening", () => {
  it("keeps server credentials out of client components", async () => {
    const clientFiles = [
      "src/features/calendar/calendar-workspace.tsx",
      "src/features/cleaning/today-queue.tsx",
      "src/features/properties/property-manager.tsx",
      "src/components/app-shell.tsx",
    ];
    for (const file of clientFiles) {
      const source = await readFile(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|ICAL_ENCRYPTION_KEY|inbound_ical_url/i);
    }
  });

  it("defines restrictive browser headers", async () => {
    const source = await readFile(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(source).toContain("Content-Security-Policy");
    expect(source).toContain("X-Frame-Options");
    expect(source).toContain("Permissions-Policy");
  });

  it("ships a cron trigger without embedding or printing the secret", async () => {
    const source = await readFile(path.join(process.cwd(), "ops/trigger-sync.sh"), "utf8");
    expect(source).toContain("SYNC_SECRET");
    expect(source).not.toMatch(/SYNC_SECRET=/);
    expect(source).not.toMatch(/echo.*SYNC_SECRET/);
  });
});
