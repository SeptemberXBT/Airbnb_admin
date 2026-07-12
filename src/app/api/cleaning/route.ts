import { updateCleaningTask } from "@/features/cleaning/cleaning-service";
import { cleaningUpdateSchema } from "@/features/cleaning/cleaning-update-schema";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    await updateCleaningTask(cleaningUpdateSchema.parse(await request.json()), user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "TEAM_BUSY") return NextResponse.json({ error: "team_busy" }, { status: 409 });
    if (error instanceof Error && error.message === "NOT_FOUND") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_update" }, { status: 400 });
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
