const exactPublicPaths = new Set(["/login", "/auth/callback", "/api/health", "/api/sync/cron"]);

export function isPublicPath(pathname: string) {
  return exactPublicPaths.has(pathname)
    || /^\/api\/ical\/[^/]+\.ics$/.test(pathname)
    || /^\/api\/internal\/v1(?:\/.*)?$/.test(pathname)
    || pathname === "/api/webhooks/razorpay";
}
