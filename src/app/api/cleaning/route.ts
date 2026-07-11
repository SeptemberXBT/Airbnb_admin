import { updateCleaningTask } from "@/features/cleaning/cleaning-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional();
const schema = z.object({
  taskId: z.uuid(), action: z.enum(["start", "ready", "delay", "skip", "edit"]),
  delayMinutes: z.number().int().min(0).max(720).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  expectedCheckoutTime: time, expectedCheckinTime: time,
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    await updateCleaningTask(schema.parse(await request.json()), user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "TEAM_BUSY") return NextResponse.json({ error: "team_busy" }, { status: 409 });
    if (error instanceof Error && error.message === "NOT_FOUND") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_update" }, { status: 400 });
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
