import { rotateOutboundToken, setOutboundFeedEnabled } from "@/features/calendar/outbound-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

const listingSchema = z.object({ listingId: z.uuid() });

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { listingId } = listingSchema.parse(await request.json());
    const token = await rotateOutboundToken(listingId, user.id);
    const origin = process.env.APP_URL ?? new URL(request.url).origin;
    return NextResponse.json({ outboundUrl: `${origin}/api/ical/${token}.ics` });
  } catch (error) {
    const status = error instanceof Error && error.message === "NOT_FOUND" ? 404 : error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ error: status === 404 ? "not_found" : status === 400 ? "invalid_listing" : "operation_failed" }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const { listingId, enabled } = listingSchema.extend({ enabled: z.boolean() }).parse(await request.json());
    await setOutboundFeedEnabled(listingId, enabled, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof Error && error.message === "NOT_FOUND" ? 404 : error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ error: status === 404 ? "not_found" : status === 400 ? "invalid_listing" : "operation_failed" }, { status });
  }
}
