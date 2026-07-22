import { NextResponse } from "next/server";
import { z } from "zod";
import { AdminTestCleanupError, removeTestBooking } from "@/features/bookings/admin-test-cleanup-service";
import { requireUser } from "@/lib/auth/require-user";

const bodySchema = z.object({
  publicReference: z.string().regex(/^NH-[A-Z0-9]{12,32}$/),
}).strict();
const paramsSchema = z.object({ bookingId: z.uuid() }).strict();

export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  try {
    const user = await requireUser();
    const { bookingId } = paramsSchema.parse(await context.params);
    const { publicReference } = bodySchema.parse(await request.json());
    const result = await removeTestBooking(user.id, bookingId, publicReference);
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_test_cleanup_request" }, { status: 400 });
    if (error instanceof AdminTestCleanupError) {
      return NextResponse.json({ error: error.code }, { status: error.httpStatus });
    }
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
