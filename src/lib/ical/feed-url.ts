export function isAllowedAirbnbCalendarUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && /(^|\.)airbnb\.[a-z.]+$/i.test(url.hostname)
      && url.pathname.startsWith("/calendar/ical/")
      && url.pathname.endsWith(".ics");
  } catch {
    return false;
  }
}
