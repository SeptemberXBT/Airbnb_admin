import { describe, expect, it } from "vitest";

import {
  decidePremiumMigrationAction,
  validateBookingWorkerUrl,
} from "./production-migration-state";

describe("decidePremiumMigrationAction", () => {
  it("applies the migration only when every marker is absent", () => {
    expect(decidePremiumMigrationAction(0, 16)).toBe("apply");
  });

  it("skips the migration when every marker is present", () => {
    expect(decidePremiumMigrationAction(16, 16)).toBe("skip");
  });

  it("stops on a partially migrated schema", () => {
    expect(() => decidePremiumMigrationAction(7, 16)).toThrow(
      "Production schema is partially migrated (7/16 markers present)",
    );
  });

  it("rejects impossible marker counts", () => {
    expect(() => decidePremiumMigrationAction(-1, 16)).toThrow("Invalid migration marker count");
    expect(() => decidePremiumMigrationAction(17, 16)).toThrow("Invalid migration marker count");
  });
});

describe("validateBookingWorkerUrl", () => {
  it("accepts the exact HTTPS booking worker endpoint", () => {
    expect(
      validateBookingWorkerUrl(
        "https://noirhausadmin-booking-preview.vercel.app/api/bookings/cron",
      ),
    ).toBe("https://noirhausadmin-booking-preview.vercel.app/api/bookings/cron");
  });

  it("rejects insecure or incorrectly scoped worker URLs", () => {
    expect(() =>
      validateBookingWorkerUrl("http://noirhausadmin.example/api/bookings/cron"),
    ).toThrow("Booking worker URL must use HTTPS");
    expect(() => validateBookingWorkerUrl("https://noirhausadmin.example/api/health")).toThrow(
      "Booking worker URL must target /api/bookings/cron",
    );
  });
});
