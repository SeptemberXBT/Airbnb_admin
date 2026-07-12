import { getVacancySummaryForUser } from "@/features/calendar/calendar-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({ start: z.iso.date(), end: z.iso.date() });

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { start, end } = schema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(await getVacancySummaryForUser(user.id, start, end));
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && ["INVALID_RANGE", "RANGE_TOO_LARGE"].includes(error.message))) {
      return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
