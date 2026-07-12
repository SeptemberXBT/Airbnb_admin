import { exportRangeSchema } from "@/features/calendar/export-range-schema";
import { exportManualBookings } from "@/features/calendar/manual-booking-export-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const { start, end } = exportRangeSchema.parse({ start: url.searchParams.get("start"), end: url.searchParams.get("end") });
    const csv = await exportManualBookings(user.id, start, end);
    return new NextResponse(csv, { headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="noir-haus-manual-bookings-${start}-to-${end}.csv"`,
      "cache-control": "private, no-store",
    } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
