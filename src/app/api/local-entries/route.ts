import { archiveLocalEntry, createLocalEntry, updateLocalEntry } from "@/features/calendar/entry-service";
import { localEntrySchema } from "@/features/calendar/local-entry-schema";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

function responseForError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "OVERLAP" || code === "INVENTORY_UNAVAILABLE") return NextResponse.json({ error: "overlap" }, { status: 409 });
  if (code === "FORBIDDEN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (code === "NOT_FOUND") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_entry", fields: z.flattenError(error).fieldErrors }, { status: 400 });
  return NextResponse.json({ error: "operation_failed" }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const input = localEntrySchema.parse(await request.json());
    const entry = await createLocalEntry(input, user.id);
    return NextResponse.json(entry, { status: 201 });
  } catch (error) { return responseForError(error); }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const entryId = z.uuid().parse(body.id);
    const input = localEntrySchema.parse(body);
    await updateLocalEntry(entryId, input, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return responseForError(error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const entryId = z.uuid().parse(new URL(request.url).searchParams.get("id"));
    await archiveLocalEntry(entryId, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return responseForError(error); }
}
