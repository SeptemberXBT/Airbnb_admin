export type PremiumMigrationAction = "apply" | "skip";

export function decidePremiumMigrationAction(
  presentMarkers: number,
  expectedMarkers: number,
): PremiumMigrationAction {
  if (
    !Number.isInteger(presentMarkers) ||
    !Number.isInteger(expectedMarkers) ||
    expectedMarkers <= 0 ||
    presentMarkers < 0 ||
    presentMarkers > expectedMarkers
  ) {
    throw new Error("Invalid migration marker count");
  }

  if (presentMarkers === 0) return "apply";
  if (presentMarkers === expectedMarkers) return "skip";

  throw new Error(
    `Production schema is partially migrated (${presentMarkers}/${expectedMarkers} markers present)`,
  );
}

export function validateBookingWorkerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Booking worker URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Booking worker URL must not contain credentials, query parameters, or a hash");
  }
  if (url.pathname !== "/api/bookings/cron") {
    throw new Error("Booking worker URL must target /api/bookings/cron");
  }
  return url.toString();
}
