import { getCalendarData } from "@/features/calendar/calendar-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({ start: z.iso.date() });

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { start } = schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json({ startDate: start, days: 28, properties: await getCalendarData(user.id, start, 28) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_window" }, { status: 400 });
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
