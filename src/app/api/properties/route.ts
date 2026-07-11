import { propertyListingSchema } from "@/features/properties/property-schema";
import { createPropertyWithListing, listPropertiesForUser, updateProperty } from "@/features/properties/property-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

function safeError(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") return { status: 401, code: "unauthorized" };
  if (error instanceof Error && error.message === "FORBIDDEN") return { status: 403, code: "forbidden" };
  return { status: 500, code: "operation_failed" };
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ properties: await listPropertiesForUser(user.id) });
  } catch (error) {
    const safe = safeError(error);
    return NextResponse.json({ error: safe.code }, { status: safe.status });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const input = propertyListingSchema.parse(await request.json());
    const created = await createPropertyWithListing(input, user.id);
    const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
    return NextResponse.json({
      propertyId: created.propertyId,
      listingId: created.listingId,
      outboundUrl: `${appUrl}/api/ical/${created.publicToken}.ics`,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_property", fields: z.flattenError(error).fieldErrors }, { status: 400 });
    const safe = safeError(error);
    return NextResponse.json({ error: safe.code }, { status: safe.status });
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const input = propertyListingSchema.extend({ propertyId: z.uuid(), listingId: z.uuid() }).parse(await request.json());
    await updateProperty(input, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_property" }, { status: 400 });
    const safe = safeError(error);
    return NextResponse.json({ error: safe.code }, { status: safe.status });
  }
}
