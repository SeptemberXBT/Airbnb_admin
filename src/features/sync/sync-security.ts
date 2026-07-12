import { createHash, timingSafeEqual } from "node:crypto";
import { FeedFetchError } from "./fetch-calendar";

export function verifySyncSecret(provided: string, expected: string) {
  if (!provided || !expected) return false;
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

const safeFeedCodes = new Set(["feed_timeout", "feed_network", "feed_too_large", "feed_malformed", "feed_url_blocked", "feed_redirect_blocked", "feed_too_many_redirects", "invalid_event_fields", "invalid_event_date_range"]);

export function sanitizeSyncError(error: unknown) {
  const rawCode = error instanceof FeedFetchError || error instanceof Error ? error.message : "";
  const code = safeFeedCodes.has(rawCode) || /^feed_http_\d{3}$/.test(rawCode) ? rawCode : "sync_failed";
  const message = code === "sync_failed" ? "Calendar synchronization failed" : "Calendar feed could not be synchronized";
  return { code, message };
}
