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
