import { isAllowedAirbnbCalendarUrl } from "@/lib/ical/feed-url";

export class FeedFetchError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super(code);
  }
}

type FetchOptions = {
  fetcher?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

export async function fetchCalendar(url: string, options: FetchOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 2_000_000;

  if (!isAllowedAirbnbCalendarUrl(url)) throw new FeedFetchError("feed_url_blocked");

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let currentUrl = url;
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        response = await fetcher(currentUrl, {
          signal: controller.signal,
          headers: { accept: "text/calendar, text/plain;q=0.9" },
          cache: "no-store",
          redirect: "manual",
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        const redirectedUrl = location ? new URL(location, currentUrl).toString() : "";
        if (!isAllowedAirbnbCalendarUrl(redirectedUrl)) throw new FeedFetchError("feed_redirect_blocked");
        if (redirectCount === 3) throw new FeedFetchError("feed_too_many_redirects");
        currentUrl = redirectedUrl;
      }
      if (!response) throw new FeedFetchError("feed_network", true);
      if (!response.ok) {
        throw new FeedFetchError(`feed_http_${response.status}`, response.status >= 500 || response.status === 429);
      }
      const declaredSize = Number(response.headers.get("content-length") ?? 0);
      if (declaredSize > maxBytes) throw new FeedFetchError("feed_too_large");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new FeedFetchError("feed_too_large");
      return text;
    } catch (error) {
      const normalized = error instanceof FeedFetchError
        ? error
        : new FeedFetchError(error instanceof DOMException && error.name === "AbortError" ? "feed_timeout" : "feed_network", true);
      if (!normalized.retryable || attempt === retries) throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new FeedFetchError("feed_network");
}
