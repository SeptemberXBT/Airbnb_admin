import { NextResponse } from "next/server";
import { z } from "zod";
import { listBookingsForUser } from "@/features/bookings/admin-booking-service";
import { requireUser } from "@/lib/auth/require-user";

const querySchema = z.object({
  search: z.string().trim().max(200).optional(),
  view: z.enum(["active", "archived", "all"]).default("active"),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(
      { bookings: await listBookingsForUser(user.id, query.search, query.view) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_search" }, { status: 400 });
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
