import {
  decidePremiumMigrationAction,
  type PremiumMigrationAction,
} from "./production-migration-state";

const EARLY_CHECKOUT_MARKER_COUNT = 4;

export function decideEarlyCheckoutMigrationAction(
  presentMarkers: number,
): PremiumMigrationAction {
  try {
    return decidePremiumMigrationAction(presentMarkers, EARLY_CHECKOUT_MARKER_COUNT);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Production schema is partially migrated")
    ) {
      throw new Error(
        `Production migration 0010 is partially applied (${presentMarkers}/${EARLY_CHECKOUT_MARKER_COUNT} markers present)`,
      );
    }
    throw error;
  }
}
