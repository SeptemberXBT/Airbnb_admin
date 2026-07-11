import { saveOperationOverride } from "@/features/calendar/entry-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
const schema = z.object({
  targetType: z.enum(["external", "local"]), targetId: z.uuid(), propertyId: z.uuid(),
  expectedCheckinTime: time, expectedCheckoutTime: time,
  cleaningDurationMinutes: z.number().int().min(5).max(480).nullable(),
  operationalNote: z.string().trim().max(2_000).nullable(),
});

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    await saveOperationOverride(schema.parse(await request.json()), user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_override" }, { status: 400 });
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
