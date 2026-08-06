import { getOutboundCalendar } from "@/features/calendar/outbound-service";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const rawToken = (await params).token.replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(rawToken)) return new NextResponse("Not found", { status: 404 });
  const calendar = await getOutboundCalendar(rawToken);
  if (!calendar) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(calendar, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": "inline; filename=haven-busy-dates.ics",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}
